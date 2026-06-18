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
  const dir = mkdtempSync(join(tmpdir(), 'zorb-use-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('zorb use — direct action execution (A11)', () => {
  test('runs a local .cjs action with no zorb.yml present', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'hello.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('hello ' + inputs.name);
          return {};
        };`,
      );
      const { exitCode, stderr } = await runCli(['use', './hello.action', '--with', 'name=alice'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('hello alice');
    } finally {
      cleanup();
    }
  });

  test('passes --with values as strings to the action', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('verbose=' + inputs.verbose + ' (type ' + typeof inputs.verbose + ')');
          return {};
        };`,
      );
      const { exitCode, stderr } = await runCli(['use', './echo.action', '--with', 'verbose=true'], { cwd: dir });
      expect(exitCode).toBe(0);
      // No input definitions → strings flow through verbatim.
      expect(stderr).toContain('verbose=true (type string)');
    } finally {
      cleanup();
    }
  });

  test('picks up workflow env: from a zorb.yml in cwd', async () => {
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
        `env:\n  FROM_WF: declared\ntasks:\n  noop:\n    steps:\n      - run: ":"\n`,
      );
      const { exitCode, stderr } = await runCli(['use', './probe.action'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('WF=declared');
    } finally {
      cleanup();
    }
  });

  test('action subprocess does NOT inherit process.env (strict env, same as `zorb run`)', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'probe.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('LEAK=' + (process.env.ZORB_LEAK_TEST || 'unset'));
          return {};
        };`,
      );
      const { exitCode, stderr } = await runCli(['use', './probe.action'], {
        cwd: dir,
        env: { ZORB_LEAK_TEST: 'should-not-be-visible' },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('LEAK=unset');
    } finally {
      cleanup();
    }
  });

  test('action subprocess sees -e/--env values', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'probe.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('CLI=' + (process.env.FROM_CLI || 'unset'));
          return {};
        };`,
      );
      const { exitCode, stderr } = await runCli(['use', './probe.action', '-e', 'FROM_CLI=hi'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('CLI=hi');
    } finally {
      cleanup();
    }
  });

  test('cross-file workflow ref delegates to runRun on the callee', async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'infra'));
      writeFileSync(
        join(dir, 'infra', 'zorb.yml'),
        `tasks:
  deploy:
    inputs:
      env:
        type: string
        required: true
    env:
      TARGET: \${{ inputs.env }}
    steps:
      - run: echo "deploying to $TARGET"
`,
      );
      const { exitCode, stdout } = await runCli(['use', './infra/zorb.deploy', '--with', 'env=staging'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('deploying to staging');
    } finally {
      cleanup();
    }
  });

  test('workflow-ref missing required input fails the same as zorb run', async () => {
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
    steps:
      - run: echo "hi"
`,
      );
      const { exitCode, stderr } = await runCli(['use', './zorb.greet'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('name');
      expect(stderr).toContain('required');
    } finally {
      cleanup();
    }
  });

  test('missing local action emits a clear error', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { exitCode, stderr } = await runCli(['use', './does-not-exist.action'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('could not resolve action');
    } finally {
      cleanup();
    }
  });

  test('missing --with key errors before launching the action', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'noop.action.cjs'), `module.exports.action = () => ({});`);
      const { exitCode, stderr } = await runCli(['use', './noop.action', '--with', 'badpair'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('invalid --with');
    } finally {
      cleanup();
    }
  });

  test('resolves an NPM package action via node_modules', async () => {
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
          ctx.log.info('sync bucket=' + inputs.bucket);
          return {};
        };`,
      );
      const { exitCode, stderr } = await runCli(['use', '@zorb/aws/s3/sync', '--with', 'bucket=my-bucket'], {
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('sync bucket=my-bucket');
    } finally {
      cleanup();
    }
  });

  test('missing @zorb/* package hints at npm install', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { exitCode, stderr } = await runCli(['use', '@zorb/aws/s3/sync', '--with', 'bucket=x'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('@zorb/aws');
      expect(stderr).toContain('npm install');
    } finally {
      cleanup();
    }
  });

  test('workflow defaults.action.js.bin applies when picked up from zorb.yml', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'echo.action.cjs'),
        `module.exports.action = () => { console.error('ran'); return {}; };`,
      );
      const BUN_ABS = Bun.which('bun') ?? process.execPath;
      const wrapper = join(dir, 'wrapper.sh');
      writeFileSync(wrapper, `#!/bin/sh\necho "__wf_bin__=$1" >&2\nexec ${BUN_ABS} "$@"\n`, { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  action:\n    js:\n      bin: "${wrapper} {0}"\ntasks:\n  noop:\n    steps:\n      - run: ":"\n`,
      );
      const { exitCode, stderr } = await runCli(['use', './echo.action'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('__wf_bin__');
      expect(stderr).toContain('ran');
    } finally {
      cleanup();
    }
  });

  test('--file points at a workflow elsewhere for env/defaults', async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'cfg'));
      writeFileSync(
        join(dir, 'cfg', 'zorb.yml'),
        `env:\n  FROM_CFG: yes\ntasks:\n  noop:\n    steps:\n      - run: ":"\n`,
      );
      writeFileSync(
        join(dir, 'probe.action.cjs'),
        `module.exports.action = (inputs, ctx) => {
          ctx.log.info('CFG=' + (process.env.FROM_CFG || 'unset'));
          return {};
        };`,
      );
      const { exitCode, stderr } = await runCli(['use', './probe.action', '--file', join(dir, 'cfg', 'zorb.yml')], {
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain('CFG=yes');
    } finally {
      cleanup();
    }
  });

  test('--file pointing at a missing workflow errors', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'noop.action.cjs'), `module.exports.action = () => ({});`);
      const { exitCode, stderr } = await runCli(['use', './noop.action', '--file', './nope.yml'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('workflow file not found');
    } finally {
      cleanup();
    }
  });

  test('missing <action> argument prints usage', async () => {
    const { exitCode, stderr } = await runCli(['use']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`'zorb use' requires an action`);
  });

  test('--help prints help text', async () => {
    const { exitCode, stdout } = await runCli(['use', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('zorb use');
    expect(stdout).toContain('--with');
  });

  test('action thrown error propagates as exit code 1', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'boom.action.cjs'), `module.exports.action = () => { throw new Error('kaboom'); };`);
      const { exitCode, stderr } = await runCli(['use', './boom.action'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('kaboom');
    } finally {
      cleanup();
    }
  });
});
