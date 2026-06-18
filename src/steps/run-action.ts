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
}

// src/steps/run-action.ts → ../../runners/. When packaged into a single binary
// (A16) we'll resolve runners from the binary's adjacent libexec; for now this
// is the only location.
const RUNNERS_DIR = resolvePath(import.meta.dir, '..', '..', 'runners');

export async function executeActionStep(opts: ExecuteActionOptions): Promise<ActionResult> {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-action-'));
  const inputFile = join(dir, 'input.json');
  const resultFile = join(dir, 'result.json');

  writeFileSync(inputFile, JSON.stringify({ inputs: opts.inputs, context: opts.context }));

  try {
    const cmd = buildRunnerCommand(opts.resolved, inputFile, resultFile);
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

function buildRunnerCommand(resolved: ResolvedAction, inputFile: string, resultFile: string): string[] {
  if (resolved.language === 'py') {
    return [pythonBin(), join(RUNNERS_DIR, 'runner.py'), resolved.path, inputFile, resultFile];
  }
  return [jsRuntime(), join(RUNNERS_DIR, 'runner.cjs'), resolved.path, inputFile, resultFile];
}

// process.execPath is the active runtime (bun in dev). We prefer it over a bare
// 'bun' so subprocess tests don't depend on PATH lookup.
function jsRuntime(): string {
  return process.execPath;
}

function pythonBin(): string {
  return process.env.PYTHON ?? 'python3';
}
