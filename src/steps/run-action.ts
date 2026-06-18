import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
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
}

export interface ExecuteActionOptions {
  resolved: ResolvedAction;
  inputs: Record<string, unknown>;
  context: ActionContextInfo;
  env: Record<string, string>;
  /** Resolved bin template (validator guarantees a non-empty string containing {0}). */
  bin: string;
}

/** Built-in defaults used when no defaults.action.{lang}.bin and no step bin: is set. */
export const DEFAULT_BINS: Record<'js' | 'py', string> = {
  js: 'bun {0}',
  py: 'python3 {0}',
};

// src/steps/run-action.ts → ../../runners/. When packaged into a single binary
// (A16) we'll resolve runners from the binary's adjacent libexec; for now this
// is the only location.
const RUNNERS_DIR = resolvePath(import.meta.dir, '..', '..', 'runners');

export async function executeActionStep(opts: ExecuteActionOptions): Promise<ActionResult> {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-action-'));
  const inputFile = join(dir, 'input.json');
  const resultFile = join(dir, 'result.json');

  const payload: Record<string, unknown> = { inputs: opts.inputs, context: opts.context };
  if (opts.resolved.kind === 'package') {
    payload.package = { anchor: opts.resolved.anchor };
  }
  writeFileSync(inputFile, JSON.stringify(payload));

  try {
    const cmd = buildRunnerCommand(opts.resolved, opts.bin, inputFile, resultFile);
    const proc = Bun.spawn({
      cmd,
      env: opts.env,
      cwd: opts.context.cwd,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await proc.exited;
    const exitCode = proc.exitCode ?? -1;

    if (exitCode !== 0) {
      return { exitCode, outputs: {}, secrets: [], env: [] };
    }

    return parseResultFile(resultFile);
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
  };
}

function buildRunnerCommand(resolved: ResolvedAction, bin: string, inputFile: string, resultFile: string): string[] {
  const language = resolved.kind === 'package' ? 'js' : resolved.language;
  const runnerScript = join(RUNNERS_DIR, language === 'py' ? 'runner.py' : 'runner.cjs');
  const argv = renderBinTemplate(bin, runnerScript);
  if (argv.length === 0) {
    throw new ActionRunError(`bin template produced no command: '${bin}'`);
  }
  argv[0] = resolveExecutable(argv[0]!);
  const target = resolved.kind === 'package' ? resolved.spec : resolved.path;
  return [...argv, target, inputFile, resultFile];
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
