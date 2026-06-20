import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.NO_COLOR = '1';

  const proc = Bun.spawn({
    cmd: ['bun', CLI, ...args],
    cwd: opts.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-init-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('zorb init', () => {
  test('scaffolds a starter zorb.yml in the current directory', async () => {
    const { dir, cleanup } = tmp();
    try {
      const target = join(dir, 'zorb.yml');
      expect(existsSync(target)).toBe(false);

      const { exitCode, stdout } = await runCli(['init'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Created zorb.yml');
      expect(existsSync(target)).toBe(true);

      const contents = readFileSync(target, 'utf-8');
      // Schema header for editor support.
      expect(contents).toContain('# yaml-language-server: $schema=');
      expect(contents).toContain('zorb.schema.json');
      // An example task that lists/parses cleanly.
      expect(contents).toContain('tasks:');
      expect(contents).toContain('hello:');
    } finally {
      cleanup();
    }
  });

  test('the scaffolded zorb.yml is recognised by `zorb list`', async () => {
    const { dir, cleanup } = tmp();
    try {
      const init = await runCli(['init'], { cwd: dir });
      expect(init.exitCode).toBe(0);

      const list = await runCli(['list'], { cwd: dir });
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain('hello');
    } finally {
      cleanup();
    }
  });

  test('errors and leaves the existing file untouched when zorb.yml already exists', async () => {
    const { dir, cleanup } = tmp();
    try {
      const target = join(dir, 'zorb.yml');
      writeFileSync(target, 'tasks:\n  custom:\n    steps:\n      - run: x\n');

      const { exitCode, stderr } = await runCli(['init'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('zorb.yml already exists');
      expect(stderr).toContain('Remove it first');

      // File contents were not overwritten.
      expect(readFileSync(target, 'utf-8')).toContain('custom');
    } finally {
      cleanup();
    }
  });

  test('--help prints command help', async () => {
    const { exitCode, stdout } = await runCli(['init', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb init');
    expect(stdout).toContain('scaffold');
  });

  test('top-level help mentions init', async () => {
    const { exitCode, stdout } = await runCli(['help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('init');
  });
});
