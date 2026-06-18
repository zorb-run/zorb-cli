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
  const dir = mkdtempSync(join(tmpdir(), 'zorb-xref-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('zorb run — cross-file workflow refs (A10)', () => {
  test('./zorb.<task> calls another task in the same file', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  build:
    steps:
      - run: echo "build ran"
  release:
    steps:
      - uses: ./zorb.build
      - run: echo "release done"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('build ran');
      expect(stdout).toContain('release done');
    } finally {
      cleanup();
    }
  });

  test('./dir/zorb.<task> calls a task in a sibling workflow file', async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'infra'));
      writeFileSync(
        join(dir, 'infra', 'zorb.yml'),
        `tasks:
  deploy:
    steps:
      - run: echo "deploying from infra"
`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  ship:
    steps:
      - uses: ./infra/zorb.deploy
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'ship'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('deploying from infra');
    } finally {
      cleanup();
    }
  });

  test('with: passes inputs to the callee task', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  greet:
    inputs:
      name:
        type: string
        required: true
    env:
      WHO: \${{ inputs.name }}
    steps:
      - run: echo "hello $WHO"
  outer:
    steps:
      - uses: ./zorb.greet
        with:
          name: alice
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'outer'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('hello alice');
    } finally {
      cleanup();
    }
  });

  test('callee inputs do NOT inherit from caller — only from with:', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  child:
    inputs:
      x:
        type: string
        required: true
    env:
      X: \${{ inputs.x }}
    steps:
      - run: echo "x=$X"
  parent:
    inputs:
      x:
        type: string
        default: parent-value
    steps:
      - uses: ./zorb.child
        with:
          x: child-value
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('x=child-value');
      expect(stdout).not.toContain('x=parent-value');
    } finally {
      cleanup();
    }
  });

  test('caller workflow.env propagates to callee shell steps', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `env:
  CALLER_VAR: from-caller
tasks:
  child:
    steps:
      - run: echo "saw=$CALLER_VAR"
  parent:
    steps:
      - uses: ./zorb.child
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('saw=from-caller');
    } finally {
      cleanup();
    }
  });

  test('caller step env propagates to callee', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  child:
    steps:
      - run: echo "step=$STEP_VAR"
  parent:
    steps:
      - uses: ./zorb.child
        env:
          STEP_VAR: from-step
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('step=from-step');
    } finally {
      cleanup();
    }
  });

  test('callee env overrides caller env for the callee scope', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `env:
  WHO: caller
tasks:
  child:
    env:
      WHO: callee
    steps:
      - run: echo "who=$WHO"
  parent:
    steps:
      - uses: ./zorb.child
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('who=callee');
    } finally {
      cleanup();
    }
  });

  test('callee uses its OWN defaults, not the caller defaults', async () => {
    // Caller declares defaults.run.cwd as a subdir that doesn't exist in the
    // callee's directory; callee declares its own (valid) defaults.run.cwd.
    // If the callee inherited caller defaults, its shell step would fail.
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'other'));
      writeFileSync(
        join(dir, 'other', 'zorb.yml'),
        `tasks:
  child:
    steps:
      - run: pwd
`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:
  run:
    cwd: this-doesnt-exist
tasks:
  parent:
    steps:
      - uses: ./other/zorb.child
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(0);
      // Callee's pwd should be its own directory (where its zorb.yml lives),
      // not affected by the caller's bogus defaults.run.cwd.
      expect(stdout).toContain('/other');
    } finally {
      cleanup();
    }
  });

  test('nested cross-file refs work to arbitrary depth', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  a:
    steps:
      - uses: ./zorb.b
  b:
    steps:
      - uses: ./zorb.c
  c:
    steps:
      - run: echo "reached c"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'a'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('reached c');
    } finally {
      cleanup();
    }
  });

  test('circular task references are detected and reported', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  a:
    steps:
      - uses: ./zorb.b
  b:
    steps:
      - uses: ./zorb.a
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'a'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('circular task reference');
      expect(stderr).toContain('a');
      expect(stderr).toContain('b');
    } finally {
      cleanup();
    }
  });

  test('a task calling itself is also a cycle', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  loop:
    steps:
      - uses: ./zorb.loop
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'loop'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('circular task reference');
    } finally {
      cleanup();
    }
  });

  test('referenced file missing — clean error', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  parent:
    steps:
      - uses: ./missing/zorb.deploy
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('workflow file not found');
    } finally {
      cleanup();
    }
  });

  test('referenced task missing — clean error with available list', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  build:
    steps:
      - run: echo build
  parent:
    steps:
      - uses: ./zorb.deploy
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`task 'deploy' not found`);
      expect(stderr).toContain('available tasks');
      expect(stderr).toContain('build');
    } finally {
      cleanup();
    }
  });

  test('callee inputs validate the same as a top-level run (missing required errors)', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  child:
    inputs:
      who:
        type: string
        required: true
    steps:
      - run: echo "hi"
  parent:
    steps:
      - uses: ./zorb.child
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('who');
      expect(stderr).toContain('required');
    } finally {
      cleanup();
    }
  });

  test('secrets registered by callee actions mask later caller output', async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'inner'));
      writeFileSync(
        join(dir, 'inner', 'load.action.cjs'),
        `module.exports.action = (i, ctx) => { ctx.setSecret('TOKEN', 'abc123'); return {}; };`,
      );
      writeFileSync(
        join(dir, 'inner', 'zorb.yml'),
        `tasks:
  setup:
    steps:
      - uses: ./load.action
`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  parent:
    env:
      LEAK: abc123
    steps:
      - uses: ./inner/zorb.setup
      - run: echo "v=$LEAK"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('v=***');
      expect(stdout).not.toContain('abc123');
    } finally {
      cleanup();
    }
  });

  test('failure inside a callee task propagates as the parent exit code', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  failing:
    steps:
      - run: exit 7
  parent:
    steps:
      - uses: ./zorb.failing
      - run: echo "never"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'parent'], { cwd: dir });
      expect(exitCode).toBe(7);
      expect(stdout).not.toContain('never');
    } finally {
      cleanup();
    }
  });
});
