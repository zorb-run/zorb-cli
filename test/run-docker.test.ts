import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDockerArgv, executeDockerStep } from '../src/steps/run-docker.ts';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-rundocker-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Make a fake `docker` binary in a temp dir that echoes its argv and the env
// vars we care about. Returns the path to put on PATH (the directory, not the
// file), so the spawned subprocess can resolve `docker` by name.
function makeFakeDocker(dir: string, body: string): string {
  const path = join(dir, 'docker');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

describe('buildDockerArgv', () => {
  test('short form: just the image, defaults shell to /bin/sh', () => {
    const argv = buildDockerArgv({
      docker: 'alpine:3.20',
      env: {},
      run: 'echo hi',
    });
    expect(argv).toEqual(['run', '--rm', '-i', 'alpine:3.20', '/bin/sh', '-c', 'echo hi']);
  });

  test('long form: image is required, other fields produce flags in a stable order', () => {
    const argv = buildDockerArgv({
      docker: {
        image: 'node:20',
        volumes: ['/host:/container', '/cache:/cache:ro'],
        network: 'host',
        workdir: '/app',
        platform: 'linux/amd64',
        entrypoint: '/bin/bash',
        pull: 'always',
      },
      env: {},
      run: 'npm test',
    });
    expect(argv).toEqual([
      'run',
      '--rm',
      '-i',
      '-v',
      '/host:/container',
      '-v',
      '/cache:/cache:ro',
      '--network',
      'host',
      '--workdir',
      '/app',
      '--platform',
      'linux/amd64',
      '--entrypoint',
      '/bin/bash',
      '--pull',
      'always',
      'node:20',
      '/bin/sh',
      '-c',
      'npm test',
    ]);
  });

  test('env: vars become `-e KEY=VALUE` pairs in iteration order', () => {
    const argv = buildDockerArgv({
      docker: 'alpine',
      env: { FOO: 'one', BAR: 'two' },
      run: 'env',
    });
    expect(argv).toEqual(['run', '--rm', '-i', '-e', 'FOO=one', '-e', 'BAR=two', 'alpine', '/bin/sh', '-c', 'env']);
  });

  test('outputMount adds a -v and ZORB_OUTPUT env pointing at the in-container path', () => {
    const argv = buildDockerArgv({
      docker: 'alpine',
      env: {},
      run: 'echo k=v >> $ZORB_OUTPUT',
      outputMount: { hostPath: '/tmp/host-output', containerPath: '/zorb-output' },
    });
    expect(argv).toContain('-v');
    expect(argv).toContain('/tmp/host-output:/zorb-output');
    expect(argv).toContain('ZORB_OUTPUT=/zorb-output');
    // The image always comes before the shell invocation.
    const imageIdx = argv.indexOf('alpine');
    expect(argv.slice(imageIdx)).toEqual(['alpine', '/bin/sh', '-c', 'echo k=v >> $ZORB_OUTPUT']);
  });

  test('pull: if-not-present maps to docker CLI `missing`', () => {
    const argv = buildDockerArgv({
      docker: { image: 'alpine', pull: 'if-not-present' },
      env: {},
      run: 'true',
    });
    const idx = argv.indexOf('--pull');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('missing');
  });

  test('pull: never and always are passed through verbatim', () => {
    const a = buildDockerArgv({ docker: { image: 'x', pull: 'never' }, env: {}, run: 't' });
    expect(a[a.indexOf('--pull') + 1]).toBe('never');
    const b = buildDockerArgv({ docker: { image: 'x', pull: 'always' }, env: {}, run: 't' });
    expect(b[b.indexOf('--pull') + 1]).toBe('always');
  });

  test('shell override changes the in-container shell', () => {
    const argv = buildDockerArgv({
      docker: 'alpine',
      env: {},
      run: 'echo hi',
      shell: '/bin/bash',
    });
    expect(argv.slice(-3)).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  test('multi-line run: is passed as a single -c argument', () => {
    const script = 'FOO=hi\necho "$FOO"';
    const argv = buildDockerArgv({ docker: 'alpine', env: {}, run: script });
    expect(argv[argv.length - 1]).toBe(script);
  });

  test('no automatic volume mounts — only what was declared', () => {
    const argv = buildDockerArgv({ docker: 'alpine', env: {}, run: 'true' });
    expect(argv).not.toContain('-v');
  });
});

describe('executeDockerStep (via fake docker binary)', () => {
  test('spawns the docker binary and propagates the exit code', async () => {
    const { dir, cleanup } = tmp();
    try {
      const fakeDir = makeFakeDocker(dir, 'exit 0');
      const result = await executeDockerStep({
        run: 'true',
        env: {},
        cwd: dir,
        docker: 'alpine',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        dockerBin: join(fakeDir, 'docker'),
      });
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('non-zero exit from docker is propagated', async () => {
    const { dir, cleanup } = tmp();
    try {
      const fakeDir = makeFakeDocker(dir, 'exit 42');
      const result = await executeDockerStep({
        run: 'true',
        env: {},
        cwd: dir,
        docker: 'alpine',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        dockerBin: join(fakeDir, 'docker'),
      });
      expect(result.exitCode).toBe(42);
    } finally {
      cleanup();
    }
  });

  test('argv handed to the docker binary matches buildDockerArgv', async () => {
    const { dir, cleanup } = tmp();
    try {
      // Capture the args the shim received so we can assert what `docker` saw.
      const fakeDir = makeFakeDocker(dir, `for arg in "$@"; do printf '%s\\n' "$arg"; done`);
      const result = await executeDockerStep({
        run: 'echo hi',
        env: { FOO: 'bar' },
        cwd: dir,
        docker: { image: 'alpine', workdir: '/app' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        dockerBin: join(fakeDir, 'docker'),
        containerName: 'zorb-fixed',
      });
      expect(result.exitCode).toBe(0);
      const lines = (result.stdout ?? '').split('\n').filter((l) => l.length > 0);
      expect(lines).toEqual([
        'run',
        '--rm',
        '-i',
        '--name',
        'zorb-fixed',
        '-e',
        'FOO=bar',
        '--workdir',
        '/app',
        'alpine',
        '/bin/sh',
        '-c',
        'echo hi',
      ]);
    } finally {
      cleanup();
    }
  });

  test('mask is applied to captured output when piped', async () => {
    const { dir, cleanup } = tmp();
    try {
      const fakeDir = makeFakeDocker(dir, `echo "password is supersecret"`);
      const result = await executeDockerStep({
        run: 'true',
        env: {},
        cwd: dir,
        docker: 'alpine',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        mask: (t) => t.split('supersecret').join('***'),
        dockerBin: join(fakeDir, 'docker'),
      });
      expect(result.stdout).toBe('password is ***\n');
    } finally {
      cleanup();
    }
  });
});
