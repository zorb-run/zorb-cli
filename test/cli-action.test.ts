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
  const dir = mkdtempSync(join(tmpdir(), 'zorb-action-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('zorb run — action steps', () => {
  test('runs a .cjs action and logs go to stderr', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'hello.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('hello from action: ' + inputs.name);
          return {};
        };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  greet:
    steps:
      - uses: ./hello.action
        with:
          name: world
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'greet'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('hello from action: world');
    } finally {
      cleanup();
    }
  });

  test('runs a .ts action via Bun', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'check.action.ts'),
        `interface Inputs { value: string }
         export const action = (inputs: Inputs, ctx: { log: { info(m: string): void } }) => {
           ctx.log.info('ts action saw: ' + inputs.value);
           return {};
         };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  go:
    steps:
      - uses: ./check.action
        with:
          value: forty-two
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'go'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('ts action saw: forty-two');
    } finally {
      cleanup();
    }
  });

  test('with: values are interpolated from inputs', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('mode=' + inputs.mode);
          return {};
        };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  release:
    inputs:
      env:
        type: string
        required: true
    steps:
      - uses: ./echo.action
        with:
          mode: "\${{ inputs.env == 'prod' ? 'production' : 'staging' }}"
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'release', '--with', 'env=prod'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('mode=production');
    } finally {
      cleanup();
    }
  });

  test('setSecret registers a value that masks later shell output', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'load.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.setSecret('TOKEN', 'supersecret');
          return {};
        };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  t:
    env:
      KNOWN_SECRET: supersecret
    steps:
      - uses: ./load.action
      - run: echo "leaking $KNOWN_SECRET"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('leaking ***');
      expect(stdout).not.toContain('supersecret');
    } finally {
      cleanup();
    }
  });

  test('setEnv registers a dynamic env var for later shell steps', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'load.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.setEnv('DYNAMIC', 'from-action');
          return {};
        };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  t:
    steps:
      - uses: ./load.action
      - run: echo "got=$DYNAMIC"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('got=from-action');
    } finally {
      cleanup();
    }
  });

  test('secrets: block runs actions before the task and registers values', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'load.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.setSecret(inputs.name, inputs.value);
          return {};
        };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `secrets:
  - uses: ./load.action
    with:
      name: DB
      value: hidden-url

tasks:
  t:
    env:
      DB: hidden-url
    steps:
      - run: echo "db=$DB"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('db=***');
      expect(stdout).not.toContain('hidden-url');
    } finally {
      cleanup();
    }
  });

  test('thrown errors print a stack trace and fail the step', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'boom.action.cjs'), `module.exports.action = () => { throw new Error('kaboom'); };`);
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  t:
    steps:
      - uses: ./boom.action
      - run: echo never
`,
      );
      const { exitCode, stdout, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('threw');
      expect(stderr).toContain('kaboom');
      expect(stderr).toMatch(/at\s+/); // a stack frame
      expect(stdout).not.toContain('never');
    } finally {
      cleanup();
    }
  });

  test('a Python action runs end-to-end', async () => {
    // Skip when python3 is unavailable (rare on dev machines but possible in CI).
    const probe = Bun.spawnSync({ cmd: ['python3', '--version'], stderr: 'ignore', stdout: 'ignore' });
    if (probe.exitCode !== 0) return;

    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'check.action.py'),
        `def action(inputs, ctx):
    ctx.log.info(f"py action: {inputs.get('what')}")
    ctx.setEnv("FROM_PY", "yes")
    return {}
`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  t:
    steps:
      - uses: ./check.action
        with:
          what: hello
      - run: echo "py=$FROM_PY"
`,
      );
      const { exitCode, stdout, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('py action: hello');
      expect(stdout).toContain('py=yes');
    } finally {
      cleanup();
    }
  });

  test('action with a missing `action` export fails clearly', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'nope.action.cjs'), `module.exports = { other: 1 };`);
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  t:\n    steps:\n      - uses: ./nope.action\n`);
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`must export an 'action' function`);
    } finally {
      cleanup();
    }
  });

  test('step id stores outputs on the run context (no expression access yet)', async () => {
    // A12 will expose `steps.<id>.outputs.<key>` in expressions; for A8 we just
    // verify the action runs and the id is accepted by the parser/runner.
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'version.action.cjs'), `module.exports.action = () => ({ tag: 'v1.2.3' });`);
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  t:
    steps:
      - id: version
        uses: ./version.action
      - run: echo done
`,
      );
      const { exitCode, stdout } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('done');
    } finally {
      cleanup();
    }
  });

  test('action subprocess does NOT inherit process.env (strict env)', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'probe.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('LEAK=' + (process.env.ZORB_LEAK_TEST || 'unset'));
          return {};
        };`,
      );
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  t:\n    steps:\n      - uses: ./probe.action\n`);
      const { exitCode, stderr } = await runCli(['run', 't'], {
        cwd: dir,
        env: { ZORB_LEAK_TEST: 'should-not-be-visible' },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('LEAK=unset');
      expect(stderr).not.toContain('should-not-be-visible');
    } finally {
      cleanup();
    }
  });

  test('action subprocess sees --env-file values', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, '.env'), 'FROM_FILE=fileval\n');
      writeFileSync(
        join(dir, 'probe.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('FILE=' + (process.env.FROM_FILE || 'unset'));
          return {};
        };`,
      );
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  t:\n    steps:\n      - uses: ./probe.action\n`);
      const { exitCode, stderr } = await runCli(['run', 't', '--env-file', join(dir, '.env')], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('FILE=fileval');
    } finally {
      cleanup();
    }
  });

  test('action subprocess sees -e/--env values (explicit declarations)', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'probe.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('CLI=' + (process.env.FROM_CLI || 'unset'));
          return {};
        };`,
      );
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  t:\n    steps:\n      - uses: ./probe.action\n`);
      const { exitCode, stderr } = await runCli(['run', 't', '-e', 'FROM_CLI=hello'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('CLI=hello');
    } finally {
      cleanup();
    }
  });

  test('action subprocess sees workflow.env declarations', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'probe.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('WF=' + (process.env.FROM_WF || 'unset'));
          return {};
        };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `env:\n  FROM_WF: declared\ntasks:\n  t:\n    steps:\n      - uses: ./probe.action\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('WF=declared');
    } finally {
      cleanup();
    }
  });

  test('shell steps still see process.env (unchanged)', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  t:\n    steps:\n      - run: echo "shell-sees=$ZORB_SHELL_TEST"\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 't'], {
        cwd: dir,
        env: { ZORB_SHELL_TEST: 'visible' },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('shell-sees=visible');
    } finally {
      cleanup();
    }
  });

  // Action subprocesses get a strict env (no PATH), so any test wrapper that
  // re-execs `bun` must use an absolute path resolved on the parent side.
  const BUN_ABS = Bun.which('bun') ?? process.execPath;

  function wrapperScript(tag: string): string {
    return `#!/bin/sh\necho "${tag}=$1" >&2\nexec ${BUN_ABS} "$@"\n`;
  }

  test('step-level bin: substitutes {0} with the runner script path', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = () => { console.error('ran'); return {}; };`,
      );
      const wrapper = join(dir, 'wrapper.sh');
      writeFileSync(wrapper, wrapperScript('__runner__'), { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  t:\n    steps:\n      - uses: ./echo.action\n        bin: "${wrapper} {0}"\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('__runner__=');
      expect(stderr).toContain('runner.cjs');
      expect(stderr).toContain('ran');
    } finally {
      cleanup();
    }
  });

  test('workflow defaults.action.js.bin applies to all js actions', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = () => { console.error('ran'); return {}; };`,
      );
      const wrapper = join(dir, 'wf-wrapper.sh');
      writeFileSync(wrapper, wrapperScript('__wf_bin__'), { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  action:\n    js:\n      bin: "${wrapper} {0}"\ntasks:\n  t:\n    steps:\n      - uses: ./echo.action\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('__wf_bin__');
      expect(stderr).toContain('ran');
    } finally {
      cleanup();
    }
  });

  test('task defaults.action.js.bin overrides workflow defaults', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = () => { console.error('ran'); return {}; };`,
      );
      const wfWrapper = join(dir, 'wf-wrapper.sh');
      const taskWrapper = join(dir, 'task-wrapper.sh');
      writeFileSync(wfWrapper, wrapperScript('__wf_bin__'), { mode: 0o755 });
      writeFileSync(taskWrapper, wrapperScript('__task_bin__'), { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  action:\n    js:\n      bin: "${wfWrapper} {0}"\ntasks:\n  t:\n    defaults:\n      action:\n        js:\n          bin: "${taskWrapper} {0}"\n    steps:\n      - uses: ./echo.action\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('__task_bin__');
      expect(stderr).not.toContain('__wf_bin__');
    } finally {
      cleanup();
    }
  });

  test('step bin: overrides task and workflow defaults', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = () => { console.error('ran'); return {}; };`,
      );
      const wfWrapper = join(dir, 'wf-wrapper.sh');
      const taskWrapper = join(dir, 'task-wrapper.sh');
      const stepWrapper = join(dir, 'step-wrapper.sh');
      writeFileSync(wfWrapper, wrapperScript('__wf_bin__'), { mode: 0o755 });
      writeFileSync(taskWrapper, wrapperScript('__task_bin__'), { mode: 0o755 });
      writeFileSync(stepWrapper, wrapperScript('__step_bin__'), { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  action:\n    js:\n      bin: "${wfWrapper} {0}"\ntasks:\n  t:\n    defaults:\n      action:\n        js:\n          bin: "${taskWrapper} {0}"\n    steps:\n      - uses: ./echo.action\n        bin: "${stepWrapper} {0}"\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('__step_bin__');
      expect(stderr).not.toContain('__task_bin__');
      expect(stderr).not.toContain('__wf_bin__');
    } finally {
      cleanup();
    }
  });

  test('bin: referencing a missing runtime fails with a clear error', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'echo.action.cjs'), `module.exports.action = () => ({});`);
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  t:\n    steps:\n      - uses: ./echo.action\n        bin: "zorb-no-such-runtime-xyz {0}"\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('zorb-no-such-runtime-xyz');
    } finally {
      cleanup();
    }
  });

  test('uses: resolves an NPM package action via node_modules', async () => {
    const { dir, cleanup } = tmp();
    try {
      const pkgDir = join(dir, 'node_modules', '@zorb', 'aws');
      mkdirSync(join(pkgDir, 'dist', 's3'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@zorb/aws', exports: { './s3/sync': './dist/s3/sync.js' } }),
      );
      writeFileSync(
        join(pkgDir, 'dist', 's3', 'sync.js'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('synced bucket=' + inputs.bucket);
          return {};
        };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  t:\n    steps:\n      - uses: "@zorb/aws/s3/sync"\n        with:\n          bucket: my-bucket\n`,
      );
      const { exitCode, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('synced bucket=my-bucket');
    } finally {
      cleanup();
    }
  });

  test('subsequent setSecret for the same name warns and keeps the first value', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'a.action.cjs'),
        `module.exports.action = (i, ctx) => { ctx.setSecret('K', 'first'); return {}; };`,
      );
      writeFileSync(
        join(dir, 'b.action.cjs'),
        `module.exports.action = (i, ctx) => { ctx.setSecret('K', 'second'); return {}; };`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  t:
    env:
      OUT: first
    steps:
      - uses: ./a.action
      - uses: ./b.action
      - run: echo "v=$OUT"
`,
      );
      const { exitCode, stdout, stderr } = await runCli(['run', 't'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain(`secret 'K' was already registered`);
      expect(stdout).toContain('v=***');
    } finally {
      cleanup();
    }
  });
});
