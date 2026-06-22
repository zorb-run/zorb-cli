import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Colors } from '../colors.ts';
import { loadWorkflow, type LoadOptions, WorkflowError } from '../config.ts';
import { RunContext } from '../context.ts';
import { interpolateMap, interpolateWith } from '../expressions.ts';
import { InputError, parseWithPairs, resolveInputs } from '../inputs.ts';
import type { Logger } from '../logger.ts';
import { executeShellStep, parseShellOutputs, ShellOutputError } from '../steps/run-shell.ts';
import { executeDockerStep } from '../steps/run-docker.ts';
import { DEFAULT_BINS, executeActionStep } from '../steps/run-action.ts';
import {
  isActionStep,
  isShellStep,
  type ActionDefaults,
  type ActionStep,
  type Backoff,
  type EnvMap,
  type Input,
  type Step,
  type Task,
  type WithMap,
  type WithValue,
  type Workflow,
} from '../types.ts';
import { parseDuration } from '../utils/duration.ts';
import { resolveUses, ResolveError, type ResolvedAction, type ResolvedWorkflow } from '../utils/resolve.ts';

// Conventional Unix exit codes: 128 + signal number. SIGINT = 2 → 130, SIGTERM = 15 → 143.
// installShutdownHandlers() aborts the controller with the signal name as the reason.
function shutdownExitCode(signal: AbortSignal | undefined): number {
  return signal?.reason === 'SIGTERM' ? 143 : 130;
}

export interface RunOptions extends LoadOptions {
  log: Logger;
  colors: Colors;
  taskName: string;
  withPairs: string[];
  /**
   * Env vars collected from --env-file and -e/--env. -e overrides --env-file
   * (the cli.ts layer handles that). This is the ONLY way the developer's
   * shell exports reach a step subprocess — `process.env` is not inherited
   * by either shell or action steps. Use `-e KEY` for explicit pass-through.
   */
  inlineEnv?: Record<string, string>;
  /**
   * Top-level shutdown signal: aborts when SIGINT/SIGTERM hits the CLI. When it
   * fires we let the in-flight step kill its subprocess(es), skip remaining
   * steps and retries, and return 130 (SIGINT) or 143 (SIGTERM).
   */
  shutdownSignal?: AbortSignal;
}

export async function runRun({
  log,
  colors,
  taskName,
  file,
  cwd,
  withPairs,
  inlineEnv = {},
  shutdownSignal,
}: RunOptions): Promise<number> {
  const { workflow, path } = loadWorkflow({ file, cwd, onWarning: (msg) => log.warn(msg) });

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

  // Strict env base — applies to shell, docker, AND action steps. Only the
  // CLI's inline env (--env-file + -e/--env, including `-e KEY` pass-through)
  // crosses into the step subprocess. process.env is never inherited; the
  // workflow author has to declare anything the step needs.
  const envBase: Record<string, string> = Object.assign(Object.create(null), inlineEnv);

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

      const outcome = await attemptStep({
        step,
        attemptCount: 1,
        log,
        execute: (signal) =>
          runActionOrWorkflowStep({
            step,
            workflow,
            task: undefined,
            inputs,
            runCtx,
            envBase,
            workflowPath: path,
            taskName,
            log,
            colors,
            cycleStack: [`${path}::${taskName}`],
            shutdownSignal: signal,
          }),
        shutdownSignal,
      });
      if (outcome.kind === 'shutdown') return shutdownExitCode(shutdownSignal);
      if (outcome.kind === 'failed') {
        log.error(`secrets step ${i + 1}/${secretsSteps.length} failed with exit code ${outcome.exitCode}`);
        return outcome.exitCode;
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
    envBase,
    runCtx,
    cycleStack: [`${path}::${taskName}`],
    shutdownSignal,
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
  envBase: Record<string, string>;
  runCtx: RunContext;
  /** Ancestor task chain: `${absoluteWorkflowPath}::${taskName}` entries. */
  cycleStack: string[];
  shutdownSignal?: AbortSignal;
}

async function runTask(args: TaskRunArgs): Promise<number> {
  const { log, colors, workflow, workflowPath, taskName, task, inputs, envBase, runCtx, cycleStack, shutdownSignal } =
    args;

  const defaultCwd = dirname(workflowPath);
  const secretsSnap = () => runCtx.getSecretsSnapshot();
  const stepsSnap = () => runCtx.getStepsSnapshot();
  const total = task.steps.length;

  for (let i = 0; i < total; i++) {
    const step = task.steps[i]!;
    const label = stepLabel(step);
    log.info(colors.gray(`> Step ${i + 1}/${total}: ${label}`));

    const attemptCount = (step.retries ?? 0) + 1;

    if (isActionStep(step)) {
      const outcome = await attemptStep({
        step,
        attemptCount,
        log,
        shutdownSignal,
        execute: (signal) =>
          runActionOrWorkflowStep({
            step,
            workflow,
            task,
            inputs,
            runCtx,
            envBase,
            workflowPath,
            taskName,
            log,
            colors,
            cycleStack,
            shutdownSignal: signal,
          }),
      });
      if (outcome.kind === 'shutdown') return shutdownExitCode(shutdownSignal);
      if (outcome.kind === 'failed') {
        log.error(`step ${i + 1}/${total} failed with exit code ${outcome.exitCode}`);
        return outcome.exitCode;
      }
      continue;
    }

    // Shell or Docker step. Both start from the strict envBase — no
    // process.env inheritance, declared/inline env only.
    const usesDocker = step.docker !== undefined;
    const acc: Record<string, string> = Object.assign(Object.create(null), envBase);
    const layer = (m: EnvMap | undefined) => {
      if (!m) return;
      Object.assign(acc, interpolateMap(m, { inputs, env: { ...acc }, secrets: secretsSnap(), steps: stepsSnap() }));
    };
    layer(workflow.defaults?.run?.env);
    layer(workflow.env);
    layer(task.defaults?.run?.env);
    layer(task.env);
    Object.assign(acc, runCtx.getDynamicEnv());
    const stepEnv = step.env
      ? interpolateMap(step.env, { inputs, env: { ...acc }, secrets: secretsSnap(), steps: stepsSnap() })
      : {};
    const effectiveEnv: Record<string, string> = Object.assign(acc, stepEnv);

    // For docker steps, defaults.run.shell is a host-shell setting and doesn't
    // belong inside the container — only honour step.shell (default /bin/sh).
    const stepShell = usesDocker
      ? step.shell
      : (step.shell ?? task.defaults?.run?.shell ?? workflow.defaults?.run?.shell);
    const cwdOverride = step.cwd ?? task.defaults?.run?.cwd ?? workflow.defaults?.run?.cwd;
    const stepCwd = cwdOverride ? resolvePath(defaultCwd, cwdOverride) : defaultCwd;

    log.debug(`  cwd: ${stepCwd}`);
    if (Object.keys(stepEnv).length > 0) log.debug(`  step env:`, stepEnv);

    const outcome = await attemptStep({
      step,
      attemptCount,
      log,
      shutdownSignal,
      execute: async (signal) => {
        // Allocate a fresh $ZORB_OUTPUT file per attempt — a previous attempt's
        // partial writes should not leak into the next one.
        const outputDir = mkdtempSync(join(tmpdir(), 'zorb-step-'));
        const outputFile = join(outputDir, 'output');
        writeFileSync(outputFile, '', { mode: 0o666 });

        try {
          let result;
          if (usesDocker) {
            // Mount the host output file inside the container at a fixed path; the
            // docker executor wires ZORB_OUTPUT to the in-container path so the
            // shell command sees the right value regardless of host pathnames.
            result = await executeDockerStep({
              run: step.run,
              env: effectiveEnv,
              cwd: stepCwd,
              docker: step.docker!,
              shell: stepShell,
              outputMount: { hostPath: outputFile, containerPath: '/zorb-output' },
              mask: runCtx.hasSecrets ? (t) => runCtx.mask(t) : undefined,
              signal,
            });
          } else {
            effectiveEnv.ZORB_OUTPUT = outputFile;
            result = await executeShellStep({
              run: step.run,
              env: effectiveEnv,
              cwd: stepCwd,
              shell: stepShell,
              mask: runCtx.hasSecrets ? (t) => runCtx.mask(t) : undefined,
              signal,
            });
          }

          // Only register outputs on a successful attempt — a failed (and
          // possibly to-be-retried) attempt shouldn't poison `steps.<id>.outputs`.
          if (result.exitCode === 0 && step.id) {
            try {
              const raw = readFileSync(outputFile, 'utf-8');
              const outputs = parseShellOutputs(raw);
              runCtx.setStepOutputs(step.id, outputs);
              if (Object.keys(outputs).length > 0) log.debug(`  outputs:`, outputs);
            } catch (e) {
              if (e instanceof ShellOutputError) {
                log.error(`step ${i + 1}/${total} produced invalid outputs: ${e.message}`);
                return 1;
              }
              throw e;
            }
          }
          return result.exitCode;
        } finally {
          rmSync(outputDir, { recursive: true, force: true });
        }
      },
    });

    if (outcome.kind === 'shutdown') return shutdownExitCode(shutdownSignal);
    if (outcome.kind === 'failed') {
      log.error(`step ${i + 1}/${total} failed with exit code ${outcome.exitCode}`);
      return outcome.exitCode;
    }
  }

  log.verbose(`completed ${total} step(s)`);
  return 0;
}

interface AttemptStepArgs {
  step: { timeout?: string; retries?: number; backoff?: Backoff };
  attemptCount: number;
  log: Logger;
  shutdownSignal?: AbortSignal;
  /** Run one attempt of the step. Receives a per-attempt signal combining shutdown + timeout. */
  execute: (signal: AbortSignal | undefined) => Promise<number>;
}

type AttemptOutcome = { kind: 'success' } | { kind: 'failed'; exitCode: number } | { kind: 'shutdown' };

// Run a step with timeout/retry semantics. Returns 'shutdown' if the run-wide
// signal aborted — the caller bails out with shutdownExitCode().
async function attemptStep(args: AttemptStepArgs): Promise<AttemptOutcome> {
  const { step, attemptCount, log, shutdownSignal, execute } = args;
  const timeoutMs = step.timeout ? parseDuration(step.timeout) : undefined;

  let lastExit = 1;
  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    if (shutdownSignal?.aborted) return { kind: 'shutdown' };

    if (attempt > 1) {
      log.info(`  retry ${attempt - 1}/${attemptCount - 1}`);
    }

    // Combine the run-wide shutdown signal with the per-attempt timeout into a
    // single AbortSignal handed to the executor. We do this locally (rather than
    // via a generic anySignal helper) so we can detach the parent-signal
    // listener after each attempt — otherwise listener references accumulate on
    // shutdownSignal across every step and every retry.
    const stepCtl = new AbortController();
    const onParentAbort = () => stepCtl.abort(shutdownSignal?.reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (shutdownSignal?.aborted) {
      stepCtl.abort(shutdownSignal.reason);
    } else {
      shutdownSignal?.addEventListener('abort', onParentAbort, { once: true });
    }
    let timedOut = false;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        stepCtl.abort('timeout');
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }

    try {
      lastExit = await execute(stepCtl.signal);
    } finally {
      if (timer) clearTimeout(timer);
      shutdownSignal?.removeEventListener('abort', onParentAbort);
    }

    if (shutdownSignal?.aborted) return { kind: 'shutdown' };

    if (timedOut) {
      log.error(`  timed out after ${step.timeout}`);
    }

    if (lastExit === 0) return { kind: 'success' };

    if (attempt < attemptCount) {
      const delay = backoffDelay(step.backoff, attempt);
      if (delay > 0) {
        log.verbose(`  backing off ${delay}ms before next attempt`);
        const slept = await interruptibleSleep(delay, shutdownSignal);
        if (!slept) return { kind: 'shutdown' };
      }
    }
  }

  return { kind: 'failed', exitCode: lastExit };
}

// linear: 1s, 2s, 3s, ...  exponential: 1s, 2s, 4s, 8s, ...
// `attempt` is the 1-based index of the attempt that JUST failed; the delay is
// applied before the NEXT attempt. Both schedules base on 1s, mirroring common
// retry-strategy defaults — small enough not to surprise users in dev, big
// enough to give a flake a chance to recover.
function backoffDelay(backoff: Backoff | undefined, attempt: number): number {
  if (!backoff) return 0;
  const base = 1000;
  if (backoff === 'linear') return base * attempt;
  return base * 2 ** (attempt - 1);
}

// Sleep that wakes early on shutdown so a long backoff doesn't trap us after
// Ctrl-C. Returns false if shutdown interrupted, true if we slept the full time.
function interruptibleSleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RunActionArgs {
  step: ActionStep;
  workflow: Workflow;
  task: Task | undefined;
  inputs: Record<string, WithValue>;
  runCtx: RunContext;
  envBase: Record<string, string>;
  workflowPath: string;
  taskName: string;
  log: Logger;
  colors: Colors;
  cycleStack: string[];
  shutdownSignal?: AbortSignal;
}

async function runActionOrWorkflowStep(args: RunActionArgs): Promise<number> {
  const {
    step,
    workflow,
    task,
    inputs,
    runCtx,
    envBase,
    workflowPath,
    taskName,
    log,
    colors,
    cycleStack,
    shutdownSignal,
  } = args;

  let resolved;
  try {
    resolved = resolveUses({ uses: step.uses, fromFile: workflowPath, onWarning: (m) => log.warn(m) });
  } catch (e) {
    if (e instanceof ResolveError) {
      log.error(e.message);
      if (e.hint) log.hint(e.hint);
      return 1;
    }
    throw e;
  }

  const secretsSnap = runCtx.getSecretsSnapshot();
  const stepsSnap = runCtx.getStepsSnapshot();

  // Action env stack: envBase → workflow.env → task.env → dynamic → step.env.
  // Notably absent: process.env (the user's shell exports never leak into a
  // step) and defaults.run.env (a `run:`-only floor). This is also the
  // "effective env" we inherit into a cross-file callee.
  const acc: Record<string, string> = Object.assign(Object.create(null), envBase);
  const layer = (m: EnvMap | undefined) => {
    if (!m) return;
    Object.assign(acc, interpolateMap(m, { inputs, env: { ...acc }, secrets: secretsSnap, steps: stepsSnap }));
  };
  layer(workflow.env);
  if (task) layer(task.env);
  Object.assign(acc, runCtx.getDynamicEnv());
  const stepEnv = step.env
    ? interpolateMap(step.env, { inputs, env: { ...acc }, secrets: secretsSnap, steps: stepsSnap })
    : {};
  const effectiveEnv: Record<string, string> = Object.assign(acc, stepEnv);

  const withMap: WithMap = step.with
    ? interpolateWith(step.with, { inputs, env: effectiveEnv, secrets: secretsSnap, steps: stepsSnap })
    : {};

  if (resolved.kind === 'workflow') {
    return runWorkflowRefStep({
      resolved,
      withMap,
      callerEffectiveEnv: effectiveEnv,
      runCtx,
      envBase,
      log,
      colors,
      cycleStack,
      shutdownSignal,
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
    shutdownSignal,
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
  shutdownSignal?: AbortSignal;
}

async function executeAction(args: ExecuteActionArgs): Promise<number> {
  const {
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
    shutdownSignal,
  } = args;

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
    signal: shutdownSignal,
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
  envBase: Record<string, string>;
  log: Logger;
  colors: Colors;
  cycleStack: string[];
  shutdownSignal?: AbortSignal;
}

async function runWorkflowRefStep(args: WorkflowRefArgs): Promise<number> {
  const { resolved, withMap, callerEffectiveEnv, runCtx, envBase, log, colors, cycleStack, shutdownSignal } = args;
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

  // Caller's effective env (workflow + task + step) merges into the callee's
  // base, so the callee inherits values the caller has already resolved. The
  // callee then layers its OWN workflow/task/step env on top inside runTask.
  // defaults.run.env is excluded (action steps don't see it anyway).
  const calleeEnvBase: Record<string, string> = Object.assign(Object.create(null), envBase, callerEffectiveEnv);

  log.info(colors.gray(`  ↳ ${calleeTaskName} (${calleePath})`));

  return runTask({
    log,
    colors,
    workflow: calleeWf,
    workflowPath: calleePath,
    taskName: calleeTaskName,
    task: calleeTask,
    inputs: calleeInputs,
    envBase: calleeEnvBase,
    runCtx,
    cycleStack: [...cycleStack, cycleKey],
    shutdownSignal,
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
