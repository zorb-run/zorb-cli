export type ShellStdio = 'inherit' | 'pipe' | 'ignore';

export interface ShellExecOptions {
  run: string;
  env: Record<string, string>;
  cwd: string;
  shell?: string;
  stdin?: 'inherit' | 'ignore';
  stdout?: ShellStdio;
  stderr?: ShellStdio;
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
export async function executeShellStep(opts: ShellExecOptions): Promise<ShellExecResult> {
  const shell = opts.shell ?? DEFAULT_SHELL;
  const stdoutMode = opts.stdout ?? 'inherit';
  const stderrMode = opts.stderr ?? 'inherit';

  const proc = Bun.spawn({
    cmd: [shell, '-c', opts.run],
    env: opts.env,
    cwd: opts.cwd,
    stdin: opts.stdin ?? 'inherit',
    stdout: stdoutMode,
    stderr: stderrMode,
  });

  const [stdoutText, stderrText] = await Promise.all([
    readPipe(stdoutMode, proc.stdout),
    readPipe(stderrMode, proc.stderr),
  ]);
  await proc.exited;

  return {
    exitCode: proc.exitCode ?? 0,
    stdout: stdoutText,
    stderr: stderrText,
  };
}

async function readPipe(mode: ShellStdio, stream: unknown): Promise<string | undefined> {
  if (mode !== 'pipe' || !stream) return undefined;
  return new Response(stream as ReadableStream).text();
}
