import { dirname, isAbsolute, resolve } from 'node:path';
import type { Colors } from '../colors.ts';
import { loadWorkflow, type LoadOptions } from '../config.ts';
import { RunContext } from '../context.ts';
import { interpolateMap } from '../expressions.ts';
import { parseWithPairs, resolveInputs } from '../inputs.ts';
import type { Logger } from '../logger.ts';
import { executeShellStep } from '../steps/run-shell.ts';
import { isActionStep, isShellStep, type EnvMap, type Input, type Step, type WithValue } from '../types.ts';

export interface RunOptions extends LoadOptions {
  log: Logger;
  colors: Colors;
  taskName: string;
  withPairs: string[];
}

export async function runRun({
  log,
  colors,
  taskName,
  file,
  cwd,
  withPairs,
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

  // Execute the secrets block sequentially before any task step.
  const secretsSteps = workflow.secrets ?? [];
  if (secretsSteps.length > 0) {
    log.verbose(`executing ${secretsSteps.length} secret(s) step(s)`);
    for (let i = 0; i < secretsSteps.length; i++) {
      const step = secretsSteps[i]!;
      log.info(colors.gray(`> Secret ${i + 1}/${secretsSteps.length}: ${step.uses}`));
      // Action runners arrive in A8.
      log.error(`uses: steps are not yet supported`);
      log.hint(`local + NPM action runners arrive in A8`);
      log.hint(`step: ${step.uses}`);
      return 1;
    }
  }

  const procEnv: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) procEnv[k] = v;
  }
  const secretsSnap = () => runCtx.getSecretsSnapshot();

  const defaultCwd = dirname(path);
  const total = task.steps.length;

  for (let i = 0; i < total; i++) {
    const step = task.steps[i]!;
    const label = stepLabel(step);
    log.info(colors.gray(`> Step ${i + 1}/${total}: ${label}`));

    if (isActionStep(step)) {
      log.error(`uses: steps are not yet supported`);
      log.hint(`local + NPM action runners arrive in A8`);
      log.hint(`step: ${step.uses}`);
      return 1;
    }

    // Env layers, lowest → highest. `defaults.run.env` is the floor at each
    // scope: explicit `env:` at the same scope wins. Each layer is interpolated
    // against the accumulated env so later layers can reference earlier ones.
    const acc: Record<string, string> = Object.assign(Object.create(null), procEnv);
    const layer = (m: EnvMap | undefined) => {
      if (!m) return;
      Object.assign(acc, interpolateMap(m, { inputs, env: { ...acc }, secrets: secretsSnap() }));
    };
    layer(workflow.defaults?.run?.env);
    layer(workflow.env);
    layer(task.defaults?.run?.env);
    layer(task.env);
    Object.assign(acc, runCtx.getDynamicEnv());
    const stepEnv = step.env
      ? interpolateMap(step.env, { inputs, env: { ...acc }, secrets: secretsSnap() })
      : {};
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
    const tag = name in provided
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
