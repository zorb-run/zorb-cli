export type ShellStdio = 'inherit' | 'pipe' | 'ignore';

export interface ShellExecOptions {
  run: string;
  env: Record<string, string>;
  cwd: string;
  shell?: string;
  stdin?: 'inherit' | 'ignore';
  stdout?: ShellStdio;
  stderr?: ShellStdio;
  mask?: (text: string) => string;
}

export interface ShellExecResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export const DEFAULT_SHELL = process.env.SHELL ?? '/bin/sh';

// Spawn `<shell> -c <run>` with the given env / cwd. Stdio defaults to
// 'inherit' so output streams live and stdin passes through (interactive
// prompts work). Tests can opt into 'pipe' to capture output.
//
// When a `mask` function is provided and the caller's stdio mode is 'inherit',
// we pipe the subprocess output internally and write it through the mask before
// forwarding to the terminal. This allows registered secret values to be
// redacted before they appear on screen.
export async function executeShellStep(opts: ShellExecOptions): Promise<ShellExecResult> {
  const shell = opts.shell ?? DEFAULT_SHELL;
  const { mask } = opts;

  const stdoutCaller: ShellStdio = opts.stdout ?? 'inherit';
  const stderrCaller: ShellStdio = opts.stderr ?? 'inherit';

  // When masking is active, we must pipe to intercept; otherwise use caller's preference.
  const stdoutSpawn: ShellStdio = stdoutCaller === 'inherit' && mask ? 'pipe' : stdoutCaller;
  const stderrSpawn: ShellStdio = stderrCaller === 'inherit' && mask ? 'pipe' : stderrCaller;

  const proc = Bun.spawn({
    cmd: [shell, '-c', opts.run],
    env: opts.env,
    cwd: opts.cwd,
    stdin: opts.stdin ?? 'inherit',
    stdout: stdoutSpawn,
    stderr: stderrSpawn,
  });

  const [stdoutText, stderrText] = await Promise.all([
    collectOutput(proc.stdout, stdoutSpawn, stdoutCaller, mask, process.stdout),
    collectOutput(proc.stderr, stderrSpawn, stderrCaller, mask, process.stderr),
  ]);
  await proc.exited;

  return {
    exitCode: proc.exitCode ?? -1,
    stdout: stdoutText,
    stderr: stderrText,
  };
}

async function collectOutput(
  stream: unknown,
  spawnMode: ShellStdio,
  callerMode: ShellStdio,
  mask: ((text: string) => string) | undefined,
  terminal: NodeJS.WriteStream,
): Promise<string | undefined> {
  if (spawnMode !== 'pipe' || !stream) return undefined;
  const raw = await new Response(stream as ReadableStream).text();
  const text = mask ? mask(raw) : raw;
  if (callerMode === 'inherit') {
    // We piped internally for masking; forward the masked text to the terminal.
    terminal.write(text);
    return undefined;
  }
  return text;
}
