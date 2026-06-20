import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { build, currentPlatform } from '../scripts/build.ts';

// End-to-end smoke tests against the compiled binary. Builds the host-platform
// binary on first run, then exercises core commands through it directly
// (bypassing the bin/zorb.cjs shim). Set ZORB_SKIP_SMOKE=1 to skip when
// iterating on unrelated code.

const REPO_ROOT = resolvePath(import.meta.dir, '..');
const HOST = currentPlatform();
const DIST_DIR = join(REPO_ROOT, 'dist');
const BIN = join(DIST_DIR, HOST, 'zorb');

const skip = process.env.ZORB_SKIP_SMOKE === '1';
const d = skip ? describe.skip : describe;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runBinary(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NO_COLOR: '1' };
  const proc = Bun.spawn({
    cmd: [BIN, ...args],
    cwd: opts.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

function tmp(prefix = 'zorb-smoke-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

beforeAll(async () => {
  if (skip) return;
  await build({
    repoRoot: REPO_ROOT,
    outDir: DIST_DIR,
    targets: [HOST],
    gitHash: '',
  });
  if (!existsSync(BIN)) throw new Error(`build did not produce ${BIN}`);
});

d('zorb binary — smoke', () => {
  test('--version prints semver', async () => {
    const { exitCode, stdout } = await runBinary(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('--help prints usage', async () => {
    const { exitCode, stdout } = await runBinary(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb');
    expect(stdout).toContain('Commands');
  });

  test('list shows tasks in workflow', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  build:
    description: Build it
    steps:
      - run: echo hi
`,
      );
      const { exitCode, stdout } = await runBinary(['list'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('build');
      expect(stdout).toContain('Build it');
    } finally {
      cleanup();
    }
  });

  test('run executes a shell step', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  hello:
    steps:
      - run: echo "hello from smoke"
`,
      );
      const { exitCode, stdout } = await runBinary(['run', 'hello'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('hello from smoke');
    } finally {
      cleanup();
    }
  });

  test('run executes a code action — exercises the runner path resolution', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'hello.action.cjs'),
        `module.exports.action = (inputs) => ({ greeting: 'hi ' + inputs.name });
`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  greet:
    steps:
      - id: h
        uses: ./hello.action
        with: { name: smoke }
      - env:
          MSG: \${{ steps.h.outputs.greeting }}
        run: echo "MSG=$MSG"
`,
      );
      const { exitCode, stdout, stderr } = await runBinary(['run', 'greet'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('MSG=hi smoke');
      expect(stderr).not.toContain('runners directory not found');
    } finally {
      cleanup();
    }
  });

  test('use runs an action directly', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
  ctx.log.info('msg=' + inputs.msg);
};
`,
      );
      const { exitCode, stderr } = await runBinary(['use', './echo.action', '--with', 'msg=ok'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('msg=ok');
    } finally {
      cleanup();
    }
  });
});

// Sanity check the dispatcher shim. It just picks ../dist/<host>/zorb relative
// to its own location — we run it via node from the repo root and assert it
// dispatched correctly.
d('zorb bin/zorb.cjs shim — dispatcher', () => {
  test('resolves the host binary and forwards args', async () => {
    const shim = join(REPO_ROOT, 'bin', 'zorb.cjs');
    const proc = Bun.spawn({
      cmd: ['node', shim, '--version'],
      env: { ...(process.env as Record<string, string>), NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(stderr).toBe('');
  });

  test('emits a helpful error when the host binary is missing', async () => {
    // Point the shim at a copy of itself sitting in a dist-less directory so
    // the existsSync check fails.
    const { dir, cleanup } = tmp('zorb-shim-missing-');
    try {
      const binDir = join(dir, 'bin');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(binDir, { recursive: true });
      const shimContents = await Bun.file(join(REPO_ROOT, 'bin', 'zorb.cjs')).text();
      writeFileSync(join(binDir, 'zorb.cjs'), shimContents);

      const proc = Bun.spawn({
        cmd: ['node', join(binDir, 'zorb.cjs'), '--version'],
        env: { ...(process.env as Record<string, string>), NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      expect(proc.exitCode).toBe(1);
      expect(stderr).toMatch(/missing binary/);
    } finally {
      cleanup();
    }
  });
});
