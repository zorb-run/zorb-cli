import { dirname, isAbsolute, resolve } from 'node:path';
import type { Colors } from '../colors.ts';
import { loadWorkflow, type LoadOptions, WorkflowError } from '../config.ts';
import { RunContext } from '../context.ts';
import { interpolateMap, interpolateWith } from '../expressions.ts';
import { InputError, parseWithPairs, resolveInputs } from '../inputs.ts';
import type { Logger } from '../logger.ts';
import { executeShellStep } from '../steps/run-shell.ts';
import { DEFAULT_BINS, executeActionStep } from '../steps/run-action.ts';
import {
  isActionStep,
  isShellStep,
  type ActionDefaults,
  type ActionStep,
  type EnvMap,
  type Input,
  type Step,
  type Task,
  type WithMap,
  type WithValue,
  type Workflow,
} from '../types.ts';
import { resolveUses, ResolveError, type ResolvedAction, type ResolvedWorkflow } from '../utils/resolve.ts';

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

  // Secrets block — actions only, executed before task steps. taskName is
  // already resolved so loaders can use it in log messages. Cross-file refs
  // in secrets: are technically allowed by the resolver but they share the
  // same RunContext; the run-scoped secret table picks up registrations from
  // any nested action.
  const secretsSteps = workflow.secrets ?? [];
  if (secretsSteps.length > 0) {
    log.verbose(`executing ${secretsSteps.length} secrets step(s)`);
    for (let i = 0; i < secretsSteps.length; i++) {
      const step = secretsSteps[i]!;
      log.info(colors.gray(`> Secret ${i + 1}/${secretsSteps.length}: ${step.uses}`));

      const code = await runActionOrWorkflowStep({
        step,
        workflow,
        task: undefined,
        inputs,
        runCtx,
        actionEnvBase,
        shellEnvBase,
        workflowPath: path,
        taskName,
        log,
        colors,
        cycleStack: [`${path}::${taskName}`],
      });
      if (code !== 0) {
        log.error(`secrets step ${i + 1}/${secretsSteps.length} failed with exit code ${code}`);
        return code;
      }
    }
  }

  return runTask({
    log,
    colors,
    workflow,
    workflowPath: path,
    taskName,
    task,
    inputs,
    shellEnvBase,
    actionEnvBase,
    runCtx,
    cycleStack: [`${path}::${taskName}`],
  });
}

interface TaskRunArgs {
  log: Logger;
  colors: Colors;
  workflow: Workflow;
  workflowPath: string;
  taskName: string;
  task: Task;
  inputs: Record<string, WithValue>;
  shellEnvBase: Record<string, string>;
  actionEnvBase: Record<string, string>;
  runCtx: RunContext;
  /** Ancestor task chain: `${absoluteWorkflowPath}::${taskName}` entries. */
  cycleStack: string[];
}

async function runTask(args: TaskRunArgs): Promise<number> {
  const {
    log,
    colors,
    workflow,
    workflowPath,
    taskName,
    task,
    inputs,
    shellEnvBase,
    actionEnvBase,
    runCtx,
    cycleStack,
  } = args;

  const defaultCwd = dirname(workflowPath);
  const secretsSnap = () => runCtx.getSecretsSnapshot();
  const total = task.steps.length;

  for (let i = 0; i < total; i++) {
    const step = task.steps[i]!;
    const label = stepLabel(step);
    log.info(colors.gray(`> Step ${i + 1}/${total}: ${label}`));

    if (isActionStep(step)) {
      const code = await runActionOrWorkflowStep({
        step,
        workflow,
        task,
        inputs,
        runCtx,
        actionEnvBase,
        shellEnvBase,
        workflowPath,
        taskName,
        log,
        colors,
        cycleStack,
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
  workflow: Workflow;
  task: Task | undefined;
  inputs: Record<string, WithValue>;
  runCtx: RunContext;
  actionEnvBase: Record<string, string>;
  shellEnvBase: Record<string, string>;
  workflowPath: string;
  taskName: string;
  log: Logger;
  colors: Colors;
  cycleStack: string[];
}

async function runActionOrWorkflowStep(args: RunActionArgs): Promise<number> {
  const {
    step,
    workflow,
    task,
    inputs,
    runCtx,
    actionEnvBase,
    shellEnvBase,
    workflowPath,
    taskName,
    log,
    colors,
    cycleStack,
  } = args;

  let resolved;
  try {
    resolved = resolveUses({ uses: step.uses, fromFile: workflowPath });
  } catch (e) {
    if (e instanceof ResolveError) {
      log.error(e.message);
      if (e.hint) log.hint(e.hint);
      return 1;
    }
    throw e;
  }

  const secretsSnap = runCtx.getSecretsSnapshot();

  // Action env stack: actionEnvBase → workflow.env → task.env → dynamic → step.env.
  // Notably absent: process.env (the user's shell exports do not leak into actions)
  // and defaults.run.env (those are the floor for `run:` steps, not for actions).
  // This is also the "effective env" we inherit into a cross-file callee.
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

  if (resolved.kind === 'workflow') {
    return runWorkflowRefStep({
      resolved,
      withMap,
      callerEffectiveEnv: effectiveEnv,
      runCtx,
      shellEnvBase,
      log,
      colors,
      cycleStack,
    });
  }

  return executeAction({
    resolved,
    step,
    workflow,
    task,
    effectiveEnv,
    withMap,
    runCtx,
    log,
    workflowPath,
    taskName,
    stepEnv,
  });
}

interface ExecuteActionArgs {
  resolved: ResolvedAction;
  step: ActionStep;
  workflow: Workflow;
  task: Task | undefined;
  effectiveEnv: Record<string, string>;
  withMap: WithMap;
  runCtx: RunContext;
  log: Logger;
  workflowPath: string;
  taskName: string;
  stepEnv: Record<string, string>;
}

async function executeAction(args: ExecuteActionArgs): Promise<number> {
  const { resolved, step, workflow, task, effectiveEnv, withMap, runCtx, log, workflowPath, taskName, stepEnv } = args;

  const bin = resolveActionBin(resolved, step, task, workflow);

  log.debug(`  action: ${resolved.path} (${resolved.language})`);
  log.debug(`  bin:    ${bin}`);
  if (Object.keys(withMap).length > 0) log.debug(`  with:`, withMap);
  if (Object.keys(stepEnv).length > 0) log.debug(`  step env:`, stepEnv);

  const result = await executeActionStep({
    resolved,
    actionFn: 'action',
    inputs: withMap,
    context: { cwd: dirname(workflowPath), taskName, stepId: step.id },
    env: effectiveEnv,
    bin,
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

interface WorkflowRefArgs {
  resolved: ResolvedWorkflow;
  withMap: WithMap;
  callerEffectiveEnv: Record<string, string>;
  runCtx: RunContext;
  shellEnvBase: Record<string, string>;
  log: Logger;
  colors: Colors;
  cycleStack: string[];
}

async function runWorkflowRefStep(args: WorkflowRefArgs): Promise<number> {
  const { resolved, withMap, callerEffectiveEnv, runCtx, shellEnvBase, log, colors, cycleStack } = args;
  const { workflowPath: calleeWfPath, taskName: calleeTaskName } = resolved;

  const cycleKey = `${calleeWfPath}::${calleeTaskName}`;
  if (cycleStack.includes(cycleKey)) {
    const trail = [...cycleStack, cycleKey].map(formatCycleEntry).join(' → ');
    log.error(`circular task reference: ${trail}`);
    return 1;
  }

  let calleeWf: Workflow;
  let calleePath: string;
  try {
    const loaded = loadWorkflow({ file: calleeWfPath });
    calleeWf = loaded.workflow;
    calleePath = loaded.path;
  } catch (e) {
    if (e instanceof WorkflowError) {
      log.error(e.format());
      return 1;
    }
    throw e;
  }

  const calleeTask = calleeWf.tasks[calleeTaskName];
  if (!calleeTask) {
    log.error(`task '${calleeTaskName}' not found in ${calleePath}`);
    const avail = Object.keys(calleeWf.tasks);
    if (avail.length > 0) log.hint(`available tasks: ${avail.join(', ')}`);
    return 1;
  }

  // Callee inputs come from `with:` only — not the caller's inputs.
  const providedStr: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(withMap)) {
    providedStr[k] = typeof v === 'string' ? v : String(v);
  }
  let calleeInputs: Record<string, WithValue>;
  try {
    calleeInputs = resolveInputs({
      taskName: calleeTaskName,
      defs: calleeTask.inputs,
      provided: providedStr,
      onWarning: (msg) => log.warn(msg),
    });
  } catch (e) {
    if (e instanceof InputError) {
      log.error(e.message);
      return 1;
    }
    throw e;
  }

  // Caller's effective env (workflow + task + step) becomes the ambient base
  // for the callee. The callee then layers its OWN workflow/task/step env on
  // top inside runTask. The callee uses its own defaults — caller's
  // defaults.run.env is excluded (action steps don't see it anyway).
  const calleeActionEnvBase: Record<string, string> = Object.assign(Object.create(null), callerEffectiveEnv);
  const calleeShellEnvBase: Record<string, string> = Object.assign(
    Object.create(null),
    shellEnvBase,
    callerEffectiveEnv,
  );

  log.info(colors.gray(`  ↳ ${calleeTaskName} (${calleePath})`));

  return runTask({
    log,
    colors,
    workflow: calleeWf,
    workflowPath: calleePath,
    taskName: calleeTaskName,
    task: calleeTask,
    inputs: calleeInputs,
    shellEnvBase: calleeShellEnvBase,
    actionEnvBase: calleeActionEnvBase,
    runCtx,
    cycleStack: [...cycleStack, cycleKey],
  });
}

function formatCycleEntry(key: string): string {
  const sep = key.lastIndexOf('::');
  if (sep === -1) return key;
  return `${key.slice(sep + 2)} (${key.slice(0, sep)})`;
}

function resolvePath(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

// Precedence: step.bin → task.defaults.action[lang].bin → workflow.defaults.action[lang].bin
// → built-in default (DEFAULT_BINS). Validator guarantees any user-supplied
// template is non-empty and contains '{0}'.
function resolveActionBin(
  resolved: ResolvedAction,
  step: ActionStep,
  task: { defaults?: { action?: ActionDefaults } } | undefined,
  workflow: { defaults?: { action?: ActionDefaults } },
): string {
  if (step.bin) return step.bin;
  const taskBin = task?.defaults?.action?.[resolved.language]?.bin;
  if (taskBin) return taskBin;
  const wfBin = workflow.defaults?.action?.[resolved.language]?.bin;
  if (wfBin) return wfBin;
  return DEFAULT_BINS[resolved.language];
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
