import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { attachProcessAbort } from '../utils/abort.ts';
import type { ResolvedAction } from '../utils/resolve.ts';

export class ActionRunError extends Error {
  override readonly name = 'ActionRunError';
}

export interface ActionContextInfo {
  cwd: string;
  taskName: string;
  stepId?: string;
}

export interface ActionResult {
  exitCode: number;
  outputs: Record<string, unknown>;
  secrets: Array<{ name: string; value: string }>;
  env: Array<{ name: string; value: string }>;
  /** True when the signal aborted the runner subprocess. */
  aborted: boolean;
}

export interface ExecuteActionOptions {
  resolved: ResolvedAction;
  /** Named export the runner should invoke; defaults to 'action'. */
  actionFn: string;
  inputs: Record<string, unknown>;
  context: ActionContextInfo;
  env: Record<string, string>;
  /** Resolved bin template (validator guarantees a non-empty string containing {0}). */
  bin: string;
  /** When the signal aborts, SIGTERM the runner then SIGKILL after the grace period. */
  signal?: AbortSignal;
  /** Grace period (ms) between SIGTERM and SIGKILL on abort. Defaults to 2000. */
  killGraceMs?: number;
}

/** Built-in defaults used when no defaults.action.{lang}.bin and no step bin: is set. */
export const DEFAULT_BINS: Record<'js' | 'py', string> = {
  js: 'bun {0}',
  py: 'python3 {0}',
};

// In dev (`bun src/cli.ts`), runners live at <repo>/runners/, two levels up from
// this file. In a compiled binary, import.meta.dir resolves into Bun's virtual
// `/$bunfs/...` filesystem and the real runners ship one level up from the
// binary (dist/<platform>/zorb → dist/runners/). Computed once on first action
// step.
let cachedRunnersDir: string | undefined;
function getRunnersDir(): string {
  if (cachedRunnersDir !== undefined) return cachedRunnersDir;
  if (!import.meta.dir.startsWith('/$bunfs')) {
    cachedRunnersDir = resolvePath(import.meta.dir, '..', '..', 'runners');
    return cachedRunnersDir;
  }
  const candidate = resolvePath(dirname(process.execPath), '..', 'runners');
  if (!existsSync(candidate)) {
    throw new ActionRunError(
      `runners directory not found next to zorb binary (expected ${candidate}). ` +
        `Reinstall zorb so the runners/ folder ships alongside the binary.`,
    );
  }
  cachedRunnersDir = candidate;
  return cachedRunnersDir;
}

export async function executeActionStep(opts: ExecuteActionOptions): Promise<ActionResult> {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-action-'));
  const inputFile = join(dir, 'input.json');
  const resultFile = join(dir, 'result.json');

  writeFileSync(inputFile, JSON.stringify({ inputs: opts.inputs, context: opts.context }));

  try {
    const cmd = buildRunnerCommand(opts.resolved, opts.actionFn, opts.bin, inputFile, resultFile);
    const proc = Bun.spawn({
      cmd,
      env: opts.env,
      cwd: opts.context.cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const detach = attachProcessAbort(proc, opts.signal, opts.killGraceMs ?? 2000);
    try {
      await proc.exited;
    } finally {
      detach();
    }
    const exitCode = proc.exitCode ?? -1;
    const aborted = opts.signal?.aborted ?? false;

    if (exitCode !== 0) {
      return { exitCode, outputs: {}, secrets: [], env: [], aborted };
    }

    return { ...parseResultFile(resultFile), aborted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseResultFile(resultFile: string): ActionResult {
  let raw: string;
  try {
    raw = readFileSync(resultFile, 'utf-8');
  } catch (err) {
    throw new ActionRunError(`runner exited 0 but did not write a result file (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ActionRunError(`runner produced invalid result JSON: ${(err as Error).message}`);
  }
  const obj = (parsed ?? {}) as {
    outputs?: Record<string, unknown>;
    secrets?: Array<{ name: string; value: string }>;
    env?: Array<{ name: string; value: string }>;
  };
  return {
    exitCode: 0,
    outputs: obj.outputs ?? {},
    secrets: obj.secrets ?? [],
    env: obj.env ?? [],
    aborted: false,
  };
}

function buildRunnerCommand(
  resolved: ResolvedAction,
  actionFn: string,
  bin: string,
  inputFile: string,
  resultFile: string,
): string[] {
  const runnerScript = join(getRunnersDir(), resolved.language === 'py' ? 'runner.py' : 'runner.cjs');
  const argv = renderBinTemplate(bin, runnerScript);
  if (argv.length === 0) {
    throw new ActionRunError(`bin template produced no command: '${bin}'`);
  }
  argv[0] = resolveExecutable(argv[0]!);
  return [...argv, resolved.path, actionFn, inputFile, resultFile];
}

// Whitespace-split the template, then substitute {0} = runner script path.
// Complex shell quoting isn't supported — the template is a simple argv
// recipe, not a shell command.
function renderBinTemplate(template: string, runnerScript: string): string[] {
  return template
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/\{0\}/g, runnerScript));
}

// Pre-flight existence check so we error clearly when the runtime isn't
// installed, instead of relying on the spawn ENOENT message. Absolute paths
// (and paths containing a separator) are trusted as-is.
function resolveExecutable(exe: string): string {
  if (exe.includes('/') || exe.includes('\\')) return exe;
  const found = Bun.which(exe);
  if (!found) {
    throw new ActionRunError(`runtime not found on PATH: '${exe}'. Install it or set bin: to an absolute path.`);
  }
  return found;
}
