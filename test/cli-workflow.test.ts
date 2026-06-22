import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  baseEnv.NO_COLOR = '1';
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete baseEnv[k];
    else baseEnv[k] = v;
  }

  const proc = Bun.spawn({
    cmd: ['bun', CLI, ...args],
    cwd: opts.cwd,
    env: baseEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-cliwf-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('zorb list', () => {
  test('lists tasks with descriptions and required inputs', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  build:
    description: Build it
    steps:
      - run: echo hi
  deploy:
    description: Deploy it
    inputs:
      env:
        type: string
        required: true
        description: Target environment
      dry-run:
        type: boolean
        default: false
    steps:
      - run: echo bye
`,
      );
      const { exitCode, stdout } = await runCli(['list'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Tasks (2)');
      expect(stdout).toContain('build');
      expect(stdout).toContain('Build it');
      expect(stdout).toContain('deploy');
      expect(stdout).toContain('Target environment');
      // Only `env` (required: true) shown — not `dry-run`
      expect(stdout).toContain('env');
      expect(stdout).not.toContain('dry-run');
    } finally {
      cleanup();
    }
  });

  test('walks parent directories to find zorb.yml', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  build:\n    steps:\n      - run: 'true'\n`);
      const child = join(dir, 'a/b');
      mkdirSync(child, { recursive: true });
      const { exitCode, stdout } = await runCli(['list'], { cwd: child });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('build');
    } finally {
      cleanup();
    }
  });

  test('--file picks an explicit workflow', async () => {
    const { dir, cleanup } = tmp();
    try {
      const file = join(dir, 'other.yml');
      writeFileSync(file, `tasks:\n  whatever:\n    steps:\n      - run: x\n`);
      const { exitCode, stdout } = await runCli(['list', '--file', file]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('whatever');
    } finally {
      cleanup();
    }
  });

  test('no zorb.yml found errors with hint', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { exitCode, stderr } = await runCli(['list'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`couldn't find zorb.yml`);
      expect(stderr).toContain('hint:');
    } finally {
      cleanup();
    }
  });

  test('validation error includes file and line', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  build:\n    setps:\n      - run: x\n`);
      const { exitCode, stderr } = await runCli(['list'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("unknown key 'setps'");
      expect(stderr).toContain('at ');
      expect(stderr).toContain(':3');
      expect(stderr).toContain("did you mean 'steps'?");
    } finally {
      cleanup();
    }
  });

  test('--help prints command help', async () => {
    const { exitCode, stdout } = await runCli(['list', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb list');
  });
});

describe('--env-file', () => {
  test('missing env-file errors before dispatch', async () => {
    const { exitCode, stderr } = await runCli(['list', '--env-file', '/no/such/file']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('env file not found');
  });

  test('loads vars and reports the count at --verbose', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, '.env'), 'ZORB_A=1\nZORB_B=2\n');
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  build:\n    steps:\n      - run: 'true'\n`);
      const { exitCode, stderr } = await runCli(['run', 'build', '--env-file', join(dir, '.env'), '--verbose'], {
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('loaded 2 env var(s)');
    } finally {
      cleanup();
    }
  });
});

describe('-e / --env inline env vars', () => {
  test('-e KEY=VALUE is reported at --verbose', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  build:\n    steps:\n      - run: 'true'\n`);
      const { exitCode, stderr } = await runCli(['run', 'build', '-e', 'ZORB_A=one', '-e', 'ZORB_B=two', '--verbose'], {
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('set 2 inline env var(s)');
    } finally {
      cleanup();
    }
  });

  test('--env is the long form', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  build:\n    steps:\n      - run: 'true'\n`);
      const { exitCode, stderr } = await runCli(['run', 'build', '--env', 'ZORB_X=y', '--verbose'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('set 1 inline env var(s)');
    } finally {
      cleanup();
    }
  });

  test('malformed pair errors with usage hint', async () => {
    const { exitCode, stderr } = await runCli(['list', '-e', '=val']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('invalid env value');
  });

  test('invalid key errors', async () => {
    const { exitCode, stderr } = await runCli(['list', '-e', '1BAD=ok']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('invalid env var name');
  });
});
