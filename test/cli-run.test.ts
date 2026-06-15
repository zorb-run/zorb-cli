import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-run-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const WORKFLOW = `tasks:
  build:
    description: Build the project
    steps:
      - name: Compile
        run: npm run build

  deploy:
    description: Deploy to an environment
    inputs:
      environment:
        type: string
        required: true
      dry-run:
        type: boolean
        default: false
      replicas:
        type: number
        default: 1
    env:
      TARGET: \${{ inputs.environment }}
    steps:
      - name: Plan
        run: echo plan
`;

describe('zorb run', () => {
  test('runs a simple task and executes its steps', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  greet:\n    description: Say hi\n    steps:\n      - name: Hello\n        run: echo "hi from zorb"\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'greet'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('greet');
      expect(stdout).toContain('Step 1/1: Hello');
      expect(stdout).toContain('hi from zorb');
    } finally {
      cleanup();
    }
  });

  test('errors when the task is not found', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stderr } = await runCli(['run', 'ghost'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`task not found: 'ghost'`);
      expect(stderr).toContain('available tasks: build, deploy');
    } finally {
      cleanup();
    }
  });

  test('errors when a required input is missing', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stderr } = await runCli(['run', 'deploy'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`missing required input 'environment'`);
    } finally {
      cleanup();
    }
  });

  test('coerces types from --with', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stdout } = await runCli(
        ['run', 'deploy', '--with', 'environment=staging', '--with', 'dry-run=yes', '--with', 'replicas=3', '--verbose'],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('environment');
      expect(stdout).toContain('"staging"');
      expect(stdout).toContain('dry-run');
      expect(stdout).toContain('true');
      expect(stdout).toContain('replicas');
      expect(stdout).toContain('3');
    } finally {
      cleanup();
    }
  });

  test('errors on bad type coercion', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stderr } = await runCli(
        ['run', 'deploy', '--with', 'environment=staging', '--with', 'replicas=three'],
        { cwd: dir },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`input 'replicas' for task 'deploy'`);
      expect(stderr).toContain('expected a number');
    } finally {
      cleanup();
    }
  });

  test('warns when --with provides an unknown key', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stderr } = await runCli(
        ['run', 'deploy', '--with', 'environment=prod', '--with', 'surprise=value'],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stderr).toContain(`warning:`);
      expect(stderr).toContain(`unknown input 'surprise'`);
    } finally {
      cleanup();
    }
  });

  test('applies defaults at --verbose level', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stdout } = await runCli(
        ['run', 'deploy', '--with', 'environment=staging', '--verbose'],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('dry-run');
      expect(stdout).toContain('false');
      expect(stdout).toContain('(default)');
    } finally {
      cleanup();
    }
  });

  test('errors on complex ${{ }} expressions with an A5 pointer', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  ternary:
    inputs:
      env:
        type: string
        required: true
    env:
      MODE: "\${{ inputs.env == 'prod' ? 'a' : 'b' }}"
    steps:
      - run: echo hi
`,
      );
      const { exitCode, stderr } = await runCli(
        ['run', 'ternary', '--with', 'env=prod', '--debug'],
        { cwd: dir },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('unsupported expression at A3');
      expect(stderr).toContain('A5');
    } finally {
      cleanup();
    }
  });

  test('plain ${{ inputs.<name> }} interpolates into task env', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  show:\n    inputs:\n      environment:\n        type: string\n        required: true\n    env:\n      TARGET: \${{ inputs.environment }}\n    steps:\n      - run: echo "target=$TARGET"\n`,
      );
      const { exitCode, stdout } = await runCli(
        ['run', 'show', '--with', 'environment=prod'],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('target=prod');
    } finally {
      cleanup();
    }
  });
});
