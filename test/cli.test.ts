import { describe, expect, test } from 'bun:test';
import pkg from '../package.json' with { type: 'json' };

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  baseEnv.NO_COLOR = '1';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete baseEnv[k];
    else baseEnv[k] = v;
  }

  const proc = Bun.spawn({
    cmd: ['bun', CLI, ...args],
    env: baseEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

describe('zorb --version', () => {
  test('prints version from package.json', async () => {
    const { exitCode, stdout } = await runCli(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(new RegExp(`^${pkg.version}( \\([0-9a-f]+\\))?$`));
  });

  test('includes git hash when invoked from a git repo', async () => {
    const { exitCode, stdout } = await runCli(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+ \([0-9a-f]+\)$/);
  });
});

describe('zorb help', () => {
  test('no args prints top-level help', async () => {
    const { exitCode, stdout } = await runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb — declarative local workflow runner');
    expect(stdout).toContain('run <task>');
    expect(stdout).toContain('use <action>');
  });

  test('--help prints top-level help', async () => {
    const { exitCode, stdout } = await runCli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Commands:');
  });

  test('-h alias prints top-level help', async () => {
    const { exitCode, stdout } = await runCli(['-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Commands:');
  });

  test('help command prints top-level help', async () => {
    const { exitCode, stdout } = await runCli(['help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Commands:');
  });

  test('help run prints run-specific help', async () => {
    const { exitCode, stdout } = await runCli(['help', 'run']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb run');
    expect(stdout).toContain('--with');
    expect(stdout).toContain('--watch');
  });

  test('help use prints use-specific help', async () => {
    const { exitCode, stdout } = await runCli(['help', 'use']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb use');
    expect(stdout).toContain('--with');
  });

  test('help <unknown> errors with hint', async () => {
    const { exitCode, stderr } = await runCli(['help', 'whatever']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown command: whatever');
  });
});

describe('zorb run', () => {
  test('without a task name errors with usage hint', async () => {
    const { exitCode, stderr } = await runCli(['run']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`'zorb run' requires a task name`);
    expect(stderr).toContain('Usage: zorb run <task>');
  });

  test('--help shows command help', async () => {
    const { exitCode, stdout } = await runCli(['run', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb run — run a task');
  });
});

describe('zorb use', () => {
  test('without an action errors with usage hint', async () => {
    const { exitCode, stderr } = await runCli(['use']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`'zorb use' requires an action`);
    expect(stderr).toContain('Usage: zorb use <action>');
  });

  test('with an action prints scaffold message and exits 0', async () => {
    const { exitCode, stdout } = await runCli(['use', './check.action']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb use ./check.action');
  });

  test('--help shows command help', async () => {
    const { exitCode, stdout } = await runCli(['use', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb use — run an action directly');
  });
});

describe('unknown commands', () => {
  test('error with hint', async () => {
    const { exitCode, stderr } = await runCli(['nonsense']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown command: nonsense');
  });
});

describe('verbosity flags', () => {
  // `zorb use` is still a scaffold (execution lands in A11), so it's a
  // workflow-free way to exercise the verbose/debug log paths.
  test('default level hides debug output', async () => {
    const { stderr } = await runCli(['use', './fake.action']);
    expect(stderr).not.toContain('[debug]');
    expect(stderr).not.toContain('[verbose]');
  });

  test('--verbose shows verbose output', async () => {
    const { stderr } = await runCli(['use', './fake.action', '--verbose']);
    expect(stderr).toContain('[verbose]');
    expect(stderr).not.toContain('[debug]');
  });

  test('-v is an alias for --verbose', async () => {
    const { stderr } = await runCli(['use', './fake.action', '-v']);
    expect(stderr).toContain('[verbose]');
  });

  test('--debug shows debug and verbose output', async () => {
    const { stderr } = await runCli(['use', './fake.action', '--debug']);
    expect(stderr).toContain('[debug]');
  });

  test('--quiet suppresses info output but keeps errors', async () => {
    const { stdout, stderr, exitCode } = await runCli(['run', '--quiet']);
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(`'zorb run' requires a task name`);
  });
});

describe('colour output', () => {
  test('NO_COLOR env disables ANSI codes', async () => {
    const { stderr } = await runCli(['run'], { NO_COLOR: '1', FORCE_COLOR: undefined });
    expect(stderr).not.toMatch(/\x1b\[/);
  });

  test('FORCE_COLOR forces ANSI codes on', async () => {
    const { stderr } = await runCli(['run'], { NO_COLOR: undefined, FORCE_COLOR: '1' });
    expect(stderr).toMatch(/\x1b\[/);
  });

  test('--no-color flag disables ANSI codes even with FORCE_COLOR', async () => {
    const { stderr } = await runCli(['run', '--no-color'], { NO_COLOR: undefined, FORCE_COLOR: '1' });
    expect(stderr).not.toMatch(/\x1b\[/);
  });
});
