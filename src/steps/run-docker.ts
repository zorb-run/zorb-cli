import type { Docker } from '../types.ts';
import type { ShellStdio } from './run-shell.ts';

export interface DockerOutputMount {
  /** Host path of the $ZORB_OUTPUT file (must exist before the container starts). */
  hostPath: string;
  /** Path inside the container where the file is mounted and ZORB_OUTPUT will point. */
  containerPath: string;
}

export interface DockerExecOptions {
  run: string;
  env: Record<string, string>;
  /** Working directory of the `docker` command itself, not the in-container cwd. */
  cwd: string;
  docker: Docker | string;
  /** In-container shell used to evaluate `run:`. Defaults to `/bin/sh`. */
  shell?: string;
  outputMount?: DockerOutputMount;
  stdin?: 'inherit' | 'ignore';
  stdout?: ShellStdio;
  stderr?: ShellStdio;
  mask?: (text: string) => string;
  /** Override the docker binary (defaults to `docker`). Useful for tests. */
  dockerBin?: string;
}

export interface DockerExecResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export const DEFAULT_CONTAINER_SHELL = '/bin/sh';

export function normaliseDocker(docker: Docker | string): Docker {
  return typeof docker === 'string' ? { image: docker } : docker;
}

export interface BuildArgvOptions {
  docker: Docker | string;
  env: Record<string, string>;
  run: string;
  shell?: string;
  outputMount?: DockerOutputMount;
}

// Build the argv passed to `docker`. Kept pure (no spawn, no I/O) so tests can
// assert the exact command line without needing a Docker daemon.
export function buildDockerArgv(opts: BuildArgvOptions): string[] {
  const d = normaliseDocker(opts.docker);
  const argv: string[] = ['run', '--rm', '-i'];

  for (const [k, v] of Object.entries(opts.env)) {
    argv.push('-e', `${k}=${v}`);
  }

  if (d.volumes) {
    for (const vol of d.volumes) argv.push('-v', vol);
  }

  if (opts.outputMount) {
    argv.push('-v', `${opts.outputMount.hostPath}:${opts.outputMount.containerPath}`);
    argv.push('-e', `ZORB_OUTPUT=${opts.outputMount.containerPath}`);
  }
  if (d.network) argv.push('--network', d.network);
  if (d.workdir) argv.push('--workdir', d.workdir);
  if (d.platform) argv.push('--platform', d.platform);
  if (d.entrypoint) argv.push('--entrypoint', d.entrypoint);
  if (d.pull) argv.push('--pull', mapPullPolicy(d.pull));

  argv.push(d.image);

  const shell = opts.shell ?? DEFAULT_CONTAINER_SHELL;
  argv.push(shell, '-c', opts.run);
  return argv;
}

// The PLAN's vocabulary is `always | never | if-not-present`. Docker's CLI
// uses `always | never | missing`, so translate the one that differs.
function mapPullPolicy(p: NonNullable<Docker['pull']>): string {
  return p === 'if-not-present' ? 'missing' : p;
}

export async function executeDockerStep(opts: DockerExecOptions): Promise<DockerExecResult> {
  const dockerBin = opts.dockerBin ?? 'docker';
  const argv = buildDockerArgv({
    docker: opts.docker,
    env: opts.env,
    run: opts.run,
    shell: opts.shell,
    outputMount: opts.outputMount,
  });

  const { mask } = opts;
  const stdoutCaller: ShellStdio = opts.stdout ?? 'inherit';
  const stderrCaller: ShellStdio = opts.stderr ?? 'inherit';
  const stdoutSpawn: ShellStdio = stdoutCaller === 'inherit' && mask ? 'pipe' : stdoutCaller;
  const stderrSpawn: ShellStdio = stderrCaller === 'inherit' && mask ? 'pipe' : stderrCaller;

  const proc = Bun.spawn({
    cmd: [dockerBin, ...argv],
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
    terminal.write(text);
    return undefined;
  }
  return text;
}
