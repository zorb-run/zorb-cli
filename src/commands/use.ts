import { join, resolve as resolvePath } from 'node:path';
import type { Colors } from '../colors.ts';
import { findWorkflowFile, loadWorkflow, type LoadOptions, WorkflowError } from '../config.ts';
import { RunContext } from '../context.ts';
import { ExpressionError, interpolateMap } from '../expressions.ts';
import { InputError, parseWithPairs } from '../inputs.ts';
import type { Logger } from '../logger.ts';
import { DEFAULT_BINS, executeActionStep } from '../steps/run-action.ts';
import type { WithMap, Workflow } from '../types.ts';
import { ResolveError, resolveUses, type ResolvedAction } from '../utils/resolve.ts';
import { runRun } from './run.ts';

export interface UseOptions extends LoadOptions {
  log: Logger;
  colors: Colors;
  /** The CLI's <action> argument — either a uses-style ref or an NPM spec. */
  action: string;
  /** Raw --with key=value pairs. */
  withPairs: string[];
  /**
   * --env-file + -e/--env collected by cli.ts. Action env is built strictly
   * from this map plus workflow.env (no process.env leak), matching the
   * declarations-only policy used by action steps in `zorb run`.
   */
  inlineEnv?: Record<string, string>;
  /** Top-level shutdown signal — passed through to runRun for workflow refs and to the runner for direct actions. */
  shutdownSignal?: AbortSignal;
}

export async function runUse({
  log,
  colors,
  action,
  file,
  cwd,
  withPairs,
  inlineEnv = {},
  shutdownSignal,
}: UseOptions): Promise<number> {
  const baseCwd = resolvePath(cwd ?? process.cwd());

  let provided: Record<string, string>;
  try {
    provided = parseWithPairs(withPairs);
  } catch (e) {
    if (e instanceof InputError) {
      log.error(e.message);
      return 1;
    }
    throw e;
  }

  // No input definitions to coerce against — values flow through to the
  // action as strings. Actions can coerce themselves if they care.
  const withMap: WithMap = Object.create(null);
  for (const [k, v] of Object.entries(provided)) withMap[k] = v;

  // zorb.yml is optional for `use`. When --file is explicit it MUST load;
  // otherwise we walk up looking for one and silently proceed without if
  // none is found. A broken zorb.yml is fatal — the user almost certainly
  // wants to fix it rather than have it silently ignored.
  let workflow: Workflow | undefined;
  let workflowPath: string | undefined;
  if (file) {
    try {
      const loaded = loadWorkflow({ file, cwd: baseCwd });
      workflow = loaded.workflow;
      workflowPath = loaded.path;
    } catch (e) {
      if (e instanceof WorkflowError) {
        log.error(e.format());
        return 1;
      }
      throw e;
    }
  } else {
    const found = findWorkflowFile({ cwd: baseCwd });
    if (found) {
      try {
        const loaded = loadWorkflow({ file: found });
        workflow = loaded.workflow;
        workflowPath = loaded.path;
        log.verbose(`using env/defaults from ${found}`);
      } catch (e) {
        if (e instanceof WorkflowError) {
          log.error(e.format());
          return 1;
        }
        throw e;
      }
    }
  }

  // Anchor on cwd. The action argument is something the user typed in their
  // shell, so a relative path resolves against their cwd — even if --file
  // points at a workflow somewhere else. node_modules lookups walk up from
  // here too; in the common case (no --file) cwd equals the workflow dir, so
  // this matches `zorb run` semantics.
  const anchorDir = baseCwd;
  let resolved;
  try {
    resolved = resolveUses({ uses: action, fromFile: join(anchorDir, 'zorb.yml'), onWarn: (m) => log.warn(m) });
  } catch (e) {
    if (e instanceof ResolveError) {
      log.error(e.message);
      if (e.hint) log.hint(e.hint);
      return 1;
    }
    throw e;
  }

  // A workflow-ref `./[dir/]zorb.<task>` is equivalent to `zorb run <task>
  // --file <resolved-yml>` — reuse runRun so input validation, env inheritance,
  // secrets handling and cycle detection all behave identically.
  if (resolved.kind === 'workflow') {
    return runRun({
      log,
      colors,
      file: resolved.workflowPath,
      taskName: resolved.taskName,
      withPairs,
      inlineEnv,
      shutdownSignal,
    });
  }

  return executeActionDirectly({
    resolved,
    workflow,
    actionArg: action,
    contextCwd: anchorDir,
    withMap,
    inlineEnv,
    log,
    colors,
    shutdownSignal,
  });
}

interface ExecuteDirectArgs {
  resolved: ResolvedAction;
  workflow: Workflow | undefined;
  actionArg: string;
  contextCwd: string;
  withMap: WithMap;
  inlineEnv: Record<string, string>;
  log: Logger;
  colors: Colors;
  shutdownSignal?: AbortSignal;
}

async function executeActionDirectly(args: ExecuteDirectArgs): Promise<number> {
  const { resolved, workflow, actionArg, contextCwd, withMap, inlineEnv, log, colors, shutdownSignal } = args;

  log.info(colors.bold(colors.cyan(actionArg)));

  const runCtx = new RunContext();
  const secretsSnap = runCtx.getSecretsSnapshot();

  // Strict env stack: inlineEnv → workflow.env. No process.env, no task layer
  // (there isn't one), no defaults.run.env (that's a shell-step floor).
  const env: Record<string, string> = Object.assign(Object.create(null), inlineEnv);
  if (workflow?.env) {
    try {
      Object.assign(env, interpolateMap(workflow.env, { inputs: {}, env: { ...env }, secrets: secretsSnap }));
    } catch (e) {
      if (e instanceof ExpressionError) {
        log.error(`workflow env: ${e.message}`);
        return 1;
      }
      throw e;
    }
  }

  const bin = workflow?.defaults?.action?.[resolved.language]?.bin ?? DEFAULT_BINS[resolved.language];

  log.debug(`  action: ${resolved.path} (${resolved.language})`);
  log.debug(`  bin:    ${bin}`);
  if (Object.keys(withMap).length > 0) log.debug(`  with:`, withMap);

  const result = await executeActionStep({
    resolved,
    actionFn: 'action',
    inputs: withMap,
    // No task in scope — empty taskName mirrors how runners surface it in logs.
    context: { cwd: contextCwd, taskName: '' },
    env,
    bin,
    signal: shutdownSignal,
  });

  return result.exitCode;
}
