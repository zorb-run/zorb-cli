import { dirname, isAbsolute, resolve } from 'node:path';
import type { Colors } from '../colors.ts';
import { loadWorkflow, type LoadOptions } from '../config.ts';
import { RunContext } from '../context.ts';
import { interpolateMap, interpolateWith } from '../expressions.ts';
import { parseWithPairs, resolveInputs } from '../inputs.ts';
import type { Logger } from '../logger.ts';
import { executeShellStep } from '../steps/run-shell.ts';
import { executeActionStep } from '../steps/run-action.ts';
import {
  isActionStep,
  isShellStep,
  type ActionStep,
  type EnvMap,
  type Input,
  type Step,
  type WithMap,
  type WithValue,
} from '../types.ts';
import { resolveAction, ResolveError } from '../utils/resolve.ts';

export interface RunOptions extends LoadOptions {
  log: Logger;
  colors: Colors;
  taskName: string;
  withPairs: string[];
  /**
   * Env vars collected from --env-file and -e/--env. Kept separate from
   * process.env so action subprocesses can be given a declaration-only
   * environment (no leak of the developer's shell exports). -e overrides
   * --env-file (the cli.ts layer handles that). Shell steps merge this with
   * process.env; actions see only this map plus workflow/task/step env: and
   * dynamic env from setEnv.
   */
  inlineEnv?: Record<string, string>;
}

export async function runRun({
  log,
  colors,
  taskName,
  file,
  cwd,
  withPairs,
  inlineEnv = {},
}: RunOptions): Promise<number> {
  const { workflow, path } = loadWorkflow({ file, cwd });

  const task = workflow.tasks[taskName];
  if (!task) {
    log.error(`task not found: '${taskName}'`);
    const available = Object.keys(workflow.tasks);
    if (available.length > 0) {
      log.hint(`available tasks: ${available.join(', ')}`);
    } else {
      log.hint(`zorb.yml defines no tasks`);
    }
    return 1;
  }

  const provided = parseWithPairs(withPairs);
  const inputs = resolveInputs({
    taskName,
    defs: task.inputs,
    provided,
    onWarning: (msg) => log.warn(msg),
  });

  log.verbose(`resolved ${Object.keys(inputs).length} input(s)`);
  log.info(formatHeader(taskName, task.description, colors));
  printInputs(log, colors, inputs, task.inputs, provided);

  const runCtx = new RunContext();

  const procEnv: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) procEnv[k] = v;
  }
  // Shell env base = process.env + inline (-e / --env-file).
  // Action env base = inline only (no process.env — strict declarations-only).
  const shellEnvBase: Record<string, string> = Object.assign(Object.create(null), procEnv, inlineEnv);
  const actionEnvBase: Record<string, string> = Object.assign(Object.create(null), inlineEnv);

  const secretsSnap = () => runCtx.getSecretsSnapshot();
  const defaultCwd = dirname(path);

  // Secrets block — actions only, executed before task steps. taskName is
  // already resolved so loaders can use it in log messages.
  const secretsSteps = workflow.secrets ?? [];
  if (secretsSteps.length > 0) {
    log.verbose(`executing ${secretsSteps.length} secrets step(s)`);
    for (let i = 0; i < secretsSteps.length; i++) {
      const step = secretsSteps[i]!;
      log.info(colors.gray(`> Secret ${i + 1}/${secretsSteps.length}: ${step.uses}`));

      const code = await runActionStep({
        step,
        workflow,
        task: undefined,
        inputs,
        runCtx,
        actionEnvBase,
        workflowPath: path,
        defaultCwd,
        taskName,
        log,
      });
      if (code !== 0) {
        log.error(`secrets step ${i + 1}/${secretsSteps.length} failed with exit code ${code}`);
        return code;
      }
    }
  }

  const total = task.steps.length;

  for (let i = 0; i < total; i++) {
    const step = task.steps[i]!;
    const label = stepLabel(step);
    log.info(colors.gray(`> Step ${i + 1}/${total}: ${label}`));

    if (isActionStep(step)) {
      const code = await runActionStep({
        step,
        workflow,
        task,
        inputs,
        runCtx,
        actionEnvBase,
        workflowPath: path,
        defaultCwd,
        taskName,
        log,
      });
      if (code !== 0) {
        log.error(`step ${i + 1}/${total} failed with exit code ${code}`);
        return code;
      }
      continue;
    }

    // Shell step — process.env + inline + workflow/task/step env.
    const acc: Record<string, string> = Object.assign(Object.create(null), shellEnvBase);
    const layer = (m: EnvMap | undefined) => {
      if (!m) return;
      Object.assign(acc, interpolateMap(m, { inputs, env: { ...acc }, secrets: secretsSnap() }));
    };
    layer(workflow.defaults?.run?.env);
    layer(workflow.env);
    layer(task.defaults?.run?.env);
    layer(task.env);
    Object.assign(acc, runCtx.getDynamicEnv());
    const stepEnv = step.env ? interpolateMap(step.env, { inputs, env: { ...acc }, secrets: secretsSnap() }) : {};
    const effectiveEnv: Record<string, string> = Object.assign(acc, stepEnv);

    const stepShell = step.shell ?? task.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
    const cwdOverride = step.cwd ?? task.defaults?.run?.cwd ?? workflow.defaults?.run?.cwd;
    const stepCwd = cwdOverride ? resolvePath(defaultCwd, cwdOverride) : defaultCwd;

    log.debug(`  cwd: ${stepCwd}`);
    if (Object.keys(stepEnv).length > 0) log.debug(`  step env:`, stepEnv);

    const result = await executeShellStep({
      run: step.run,
      env: effectiveEnv,
      cwd: stepCwd,
      shell: stepShell,
      mask: runCtx.hasSecrets ? (t) => runCtx.mask(t) : undefined,
    });

    if (result.exitCode !== 0) {
      log.error(`step ${i + 1}/${total} failed with exit code ${result.exitCode}`);
      return result.exitCode;
    }
  }

  log.verbose(`completed ${total} step(s)`);
  return 0;
}

interface RunActionArgs {
  step: ActionStep;
  workflow: { defaults?: { run?: { env?: EnvMap } }; env?: EnvMap };
  task: { defaults?: { run?: { env?: EnvMap } }; env?: EnvMap } | undefined;
  inputs: Record<string, WithValue>;
  runCtx: RunContext;
  actionEnvBase: Record<string, string>;
  workflowPath: string;
  defaultCwd: string;
  taskName: string;
  log: Logger;
}

async function runActionStep(args: RunActionArgs): Promise<number> {
  const { step, workflow, task, inputs, runCtx, actionEnvBase, workflowPath, defaultCwd, taskName, log } = args;

  let resolved;
  try {
    resolved = resolveAction({ uses: step.uses, fromFile: workflowPath });
  } catch (e) {
    if (e instanceof ResolveError) {
      log.error(e.message);
      if (e.hint) log.hint(e.hint);
      return 1;
    }
    throw e;
  }

  const secretsSnap = runCtx.getSecretsSnapshot();

  // Action env stack: inline (-e / --env-file) → workflow.env → task.env →
  // dynamic (setEnv) → step.env. Notably absent: process.env (the user's shell
  // exports do not leak into actions) and defaults.run.env (those are the
  // floor for `run:` steps, not for actions).
  const acc: Record<string, string> = Object.assign(Object.create(null), actionEnvBase);
  const layer = (m: EnvMap | undefined) => {
    if (!m) return;
    Object.assign(acc, interpolateMap(m, { inputs, env: { ...acc }, secrets: secretsSnap }));
  };
  layer(workflow.env);
  if (task) layer(task.env);
  Object.assign(acc, runCtx.getDynamicEnv());
  const stepEnv = step.env ? interpolateMap(step.env, { inputs, env: { ...acc }, secrets: secretsSnap }) : {};
  const effectiveEnv: Record<string, string> = Object.assign(acc, stepEnv);

  const withMap: WithMap = step.with
    ? interpolateWith(step.with, { inputs, env: effectiveEnv, secrets: secretsSnap })
    : {};

  log.debug(`  action: ${resolved.path} (${resolved.language})`);
  if (Object.keys(withMap).length > 0) log.debug(`  with:`, withMap);
  if (Object.keys(stepEnv).length > 0) log.debug(`  step env:`, stepEnv);

  const result = await executeActionStep({
    resolved,
    inputs: withMap,
    context: { cwd: defaultCwd, taskName, stepId: step.id },
    env: effectiveEnv,
  });

  if (result.exitCode !== 0) return result.exitCode;

  for (const { name, value } of result.secrets) {
    const accepted = runCtx.setSecret(name, value);
    if (!accepted) log.warn(`secret '${name}' was already registered — keeping the first value`);
  }
  for (const { name, value } of result.env) {
    runCtx.setEnv(name, value);
  }
  if (step.id) runCtx.setStepOutputs(step.id, result.outputs);

  return 0;
}

function resolvePath(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

function stepLabel(step: Step): string {
  if (step.name) return step.name;
  if (step.id) return step.id;
  return isShellStep(step) ? oneLine(step.run) : step.uses;
}

function oneLine(text: string): string {
  const first = text.split('\n', 1)[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function formatHeader(name: string, desc: string | undefined, colors: Colors): string {
  return desc ? `${colors.bold(colors.cyan(name))} — ${desc}` : colors.bold(colors.cyan(name));
}

function printInputs(
  log: Logger,
  colors: Colors,
  resolved: Record<string, WithValue>,
  defs: Record<string, Input> | undefined,
  provided: Record<string, string>,
): void {
  if (log.level === 'normal' || log.level === 'quiet') return;
  const keys = Object.keys(resolved);
  if (keys.length === 0) return;
  log.info(`  ${colors.bold('Inputs')}:`);
  const width = Math.max(...keys.map((k) => k.length));
  for (const name of keys) {
    const tag =
      name in provided
        ? colors.gray('(provided)')
        : defs?.[name]?.default !== undefined
          ? colors.gray('(default)')
          : colors.gray('(unknown)');
    log.info(`    ${colors.yellow(name.padEnd(width))} = ${formatValue(resolved[name]!)}  ${tag}`);
  }
}

function formatValue(v: WithValue): string {
  return typeof v === 'string' ? `"${v}"` : String(v);
}
