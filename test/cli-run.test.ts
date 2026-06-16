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

  test('ternary expression resolves in task env', async () => {
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
      MODE: "\${{ inputs.env == 'prod' ? 'production' : 'staging' }}"
    steps:
      - run: echo "mode=$MODE"
`,
      );
      const { exitCode, stdout } = await runCli(
        ['run', 'ternary', '--with', 'env=prod'],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('mode=production');
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

describe('zorb run — shell execution', () => {
  test('runs steps sequentially and streams their output', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  multi:\n    steps:\n      - run: echo first\n      - run: echo second\n      - run: echo third\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'multi'], { cwd: dir });
      expect(exitCode).toBe(0);
      const firstIdx = stdout.indexOf('first');
      const secondIdx = stdout.indexOf('second');
      const thirdIdx = stdout.indexOf('third');
      expect(firstIdx).toBeGreaterThan(-1);
      expect(secondIdx).toBeGreaterThan(firstIdx);
      expect(thirdIdx).toBeGreaterThan(secondIdx);
    } finally {
      cleanup();
    }
  });

  test('prints a step header before each step', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  named:\n    steps:\n      - name: First\n        run: echo a\n      - name: Second\n        run: echo b\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'named'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Step 1/2: First');
      expect(stdout).toContain('Step 2/2: Second');
    } finally {
      cleanup();
    }
  });

  test('stops on the first non-zero exit and propagates it', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  fail:\n    steps:\n      - name: First\n        run: echo first\n      - name: Boom\n        run: exit 17\n      - name: Never\n        run: echo never\n`,
      );
      const { exitCode, stdout, stderr } = await runCli(['run', 'fail'], { cwd: dir });
      expect(exitCode).toBe(17);
      expect(stdout).toContain('first');
      expect(stdout).not.toContain('never');
      expect(stderr).toContain('step 2/3 failed');
      expect(stderr).toContain('exit code 17');
    } finally {
      cleanup();
    }
  });

  test('step env overrides task env, which overrides workflow env', async () => {
    const { dir, cleanup } = tmp();
    try {
      const yaml = `env:
  LAYER: workflow
tasks:
  layered:
    env:
      LAYER: task
    steps:
      - name: task wins
        run: echo "task=$LAYER"
      - name: step wins
        env:
          LAYER: step
        run: echo "step=$LAYER"
`;
      writeFileSync(join(dir, 'zorb.yml'), yaml);
      const { exitCode, stdout } = await runCli(['run', 'layered'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('task=task');
      expect(stdout).toContain('step=step');
    } finally {
      cleanup();
    }
  });

  test('process env passes through to the step', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  showenv:\n    steps:\n      - run: 'echo "from-parent: $ZORB_PARENT_TEST"'\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'showenv'], {
        cwd: dir,
        env: { ZORB_PARENT_TEST: 'inherited' },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('from-parent: inherited');
    } finally {
      cleanup();
    }
  });

  test('step cwd is resolved relative to the workflow file', async () => {
    const { dir, cleanup } = tmp();
    try {
      const sub = join(dir, 'sub');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  here:\n    steps:\n      - cwd: ./sub\n        run: pwd\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'here'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('/sub');
    } finally {
      cleanup();
    }
  });

  test('multi-line run: blocks execute as one shell invocation', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  multiline:\n    steps:\n      - run: |\n          FOO=hi\n          echo "$FOO from $FOO"\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'multiline'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('hi from hi');
    } finally {
      cleanup();
    }
  });

  test('uses: steps error with an A8 hint', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  release:\n    steps:\n      - uses: ./scripts/tag.action\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('uses: steps are not yet supported');
      expect(stderr).toContain('A8');
    } finally {
      cleanup();
    }
  });
});
