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

export class ShellOutputError extends Error {
  override readonly name = 'ShellOutputError';
}

const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// Parse a $ZORB_OUTPUT file. Supports two line shapes, mirroring GitHub
// Actions' $GITHUB_OUTPUT format:
//   key=value
//   key<<DELIM
//   …multi-line value…
//   DELIM
// Blank lines and lines starting with `#` are ignored. Repeated keys
// overwrite earlier values (last write wins).
export function parseShellOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const lines = text.split('\n');
  // Trailing newline produces a final empty string element — drop it so
  // we don't treat it as a stray blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '' || line.startsWith('#')) continue;

    const hd = /^([a-zA-Z_][a-zA-Z0-9_-]*)<<([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
    if (hd) {
      const key = hd[1]!;
      const delim = hd[2]!;
      const valLines: string[] = [];
      let closed = false;
      while (++i < lines.length) {
        if (lines[i] === delim) {
          closed = true;
          break;
        }
        valLines.push(lines[i]!);
      }
      if (!closed) {
        throw new ShellOutputError(`unterminated heredoc for output '${key}' (expected closing '${delim}')`);
      }
      out[key] = valLines.join('\n');
      continue;
    }

    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq);
      if (KEY_RE.test(key)) {
        out[key] = line.slice(eq + 1);
        continue;
      }
    }
    throw new ShellOutputError(`invalid line in $ZORB_OUTPUT: ${JSON.stringify(line)}`);
  }
  return out;
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
