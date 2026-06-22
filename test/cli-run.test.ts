import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        ['run', 'deploy', '--with', 'environment=staging', 'dry-run=yes', 'replicas=3', '--verbose'],
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
      const { exitCode, stderr } = await runCli(['run', 'deploy', '--with', 'environment=staging', 'replicas=three'], {
        cwd: dir,
      });
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
      const { exitCode, stderr } = await runCli(['run', 'deploy', '--with', 'environment=prod', 'surprise=value'], {
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain(`warning:`);
      expect(stderr).toContain(`unknown input 'surprise'`);
    } finally {
      cleanup();
    }
  });

  test('rejects repeated --with flags', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stderr } = await runCli(
        ['run', 'deploy', '--with', 'environment=staging', '--with', 'dry-run=true'],
        { cwd: dir },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--with is not repeatable');
    } finally {
      cleanup();
    }
  });

  test('errors when --with is followed by no pair', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stderr } = await runCli(['run', 'deploy', '--with', '--verbose'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--with requires at least one key=value pair');
    } finally {
      cleanup();
    }
  });

  test('rejects --with=<pair> equals form', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stderr } = await runCli(['run', 'deploy', '--with=environment=staging'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`--with does not accept '='`);
      expect(stderr).toContain(`--with <value>`);
    } finally {
      cleanup();
    }
  });

  test('rejects equals form on other flags too (--file=, --env-file=, -e=)', async () => {
    for (const args of [
      ['run', 'deploy', '--file=zorb.yml'],
      ['run', 'deploy', '--env-file=.env'],
      ['run', 'deploy', '-e=FOO=bar'],
      ['run', 'deploy', '--watch=*.ts'],
    ]) {
      const { exitCode, stderr } = await runCli(args);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`does not accept '='`);
    }
  });

  test('applies defaults at --verbose level', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), WORKFLOW);
      const { exitCode, stdout } = await runCli(['run', 'deploy', '--with', 'environment=staging', '--verbose'], {
        cwd: dir,
      });
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
      const { exitCode, stdout } = await runCli(['run', 'ternary', '--with', 'env=prod'], { cwd: dir });
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
      const { exitCode, stdout } = await runCli(['run', 'show', '--with', 'environment=prod'], { cwd: dir });
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

  test('process env does NOT pass through to the step (strict isolation)', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  showenv:\n    steps:\n      - run: 'echo "from-parent=[$ZORB_PARENT_TEST]"'\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'showenv'], {
        cwd: dir,
        env: { ZORB_PARENT_TEST: 'should-not-leak' },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('from-parent=[]');
      expect(stdout).not.toContain('should-not-leak');
    } finally {
      cleanup();
    }
  });

  test('process env can be opted in explicitly with -e KEY', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  showenv:\n    steps:\n      - run: 'echo "passed=$ZORB_PARENT_TEST"'\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'showenv', '-e', 'ZORB_PARENT_TEST'], {
        cwd: dir,
        env: { ZORB_PARENT_TEST: 'opted-in' },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('passed=opted-in');
    } finally {
      cleanup();
    }
  });

  test('step cwd is resolved relative to the workflow file', async () => {
    const { dir, cleanup } = tmp();
    try {
      const sub = join(dir, 'sub');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  here:\n    steps:\n      - cwd: ./sub\n        run: pwd\n`);
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

  test('workflow defaults.run.shell sets the default shell', async () => {
    const { dir, cleanup } = tmp();
    try {
      const wrapper = join(dir, 'shell-wrapper.sh');
      writeFileSync(wrapper, `#!/bin/sh\necho "__wf_shell__"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    shell: "${wrapper}"\ntasks:\n  s:\n    steps:\n      - run: echo ok\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 's'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('__wf_shell__');
    } finally {
      cleanup();
    }
  });

  test('task defaults.run.shell overrides workflow defaults', async () => {
    const { dir, cleanup } = tmp();
    try {
      const wfWrapper = join(dir, 'wf-shell-wrapper.sh');
      const taskWrapper = join(dir, 'task-shell-wrapper.sh');
      writeFileSync(wfWrapper, `#!/bin/sh\necho "__wf_shell__"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      writeFileSync(taskWrapper, `#!/bin/sh\necho "__task_shell__"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    shell: "${wfWrapper}"\ntasks:\n  s:\n    defaults:\n      run:\n        shell: "${taskWrapper}"\n    steps:\n      - run: echo ok\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 's'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('__task_shell__');
      expect(stdout).not.toContain('__wf_shell__');
    } finally {
      cleanup();
    }
  });

  test('step shell overrides defaults at every scope', async () => {
    const { dir, cleanup } = tmp();
    try {
      const wfWrapper = join(dir, 'wf-shell-wrapper.sh');
      const taskWrapper = join(dir, 'task-shell-wrapper.sh');
      const stepWrapper = join(dir, 'step-shell-wrapper.sh');
      writeFileSync(wfWrapper, `#!/bin/sh\necho "__wf_shell__"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      writeFileSync(taskWrapper, `#!/bin/sh\necho "__task_shell__"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      writeFileSync(stepWrapper, `#!/bin/sh\necho "__step_shell__"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    shell: "${wfWrapper}"\ntasks:\n  s:\n    defaults:\n      run:\n        shell: "${taskWrapper}"\n    steps:\n      - shell: "${stepWrapper}"\n        run: echo ok\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 's'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('__step_shell__');
      expect(stdout).not.toContain('__task_shell__');
      expect(stdout).not.toContain('__wf_shell__');
    } finally {
      cleanup();
    }
  });

  test('workflow defaults.run.cwd applies when step has none', async () => {
    const { dir, cleanup } = tmp();
    try {
      const sub = join(dir, 'sub');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    cwd: ./sub\ntasks:\n  here:\n    steps:\n      - run: pwd\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'here'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('/sub');
    } finally {
      cleanup();
    }
  });

  test('task defaults.run.cwd overrides workflow defaults', async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'a'), { recursive: true });
      mkdirSync(join(dir, 'b'), { recursive: true });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    cwd: ./a\ntasks:\n  here:\n    defaults:\n      run:\n        cwd: ./b\n    steps:\n      - run: pwd\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'here'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/\/b\b/);
      expect(stdout).not.toMatch(/\/a\b/);
    } finally {
      cleanup();
    }
  });

  test('step cwd overrides defaults', async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'a'), { recursive: true });
      mkdirSync(join(dir, 'b'), { recursive: true });
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    cwd: ./a\ntasks:\n  here:\n    steps:\n      - cwd: ./b\n        run: pwd\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'here'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/\/b\b/);
    } finally {
      cleanup();
    }
  });

  test('workflow defaults.run.env provides default env vars', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    env:\n      DEFAULTED: from-defaults\ntasks:\n  s:\n    steps:\n      - run: echo "v=$DEFAULTED"\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 's'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('v=from-defaults');
    } finally {
      cleanup();
    }
  });

  test('explicit env overrides defaults.run.env at every scope', async () => {
    const { dir, cleanup } = tmp();
    try {
      // workflow defaults.run.env is the floor; workflow.env, task.defaults.run.env,
      // task.env, and step.env each override it in turn.
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    env:\n      LAYER: wf-defaults\nenv:\n  LAYER: wf\ntasks:\n  s:\n    defaults:\n      run:\n        env:\n          LAYER: task-defaults\n    env:\n      LAYER: task\n    steps:\n      - run: echo "task=$LAYER"\n      - env:\n          LAYER: step\n        run: echo "step=$LAYER"\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 's'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('task=task');
      expect(stdout).toContain('step=step');
    } finally {
      cleanup();
    }
  });

  test('task defaults.run.env overrides workflow defaults.run.env', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `defaults:\n  run:\n    env:\n      LAYER: wf-defaults\ntasks:\n  s:\n    defaults:\n      run:\n        env:\n          LAYER: task-defaults\n    steps:\n      - run: echo "v=$LAYER"\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 's'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('v=task-defaults');
    } finally {
      cleanup();
    }
  });

  test('uses: with an unresolved local path errors with a tried list', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  release:\n    steps:\n      - uses: ./scripts/tag.action\n`);
      const { exitCode, stderr } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`could not resolve action './scripts/tag.action'`);
      expect(stderr).toContain('tried:');
      expect(stderr).toContain('tag.action.js');
      expect(stderr).toContain('tag.action.py');
    } finally {
      cleanup();
    }
  });

  test('uses: with a missing @zorb/* package errors with an install hint', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  release:\n    steps:\n      - uses: "@zorb/aws/s3/sync"\n`);
      const { exitCode, stderr } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('@zorb/aws');
      expect(stderr).toContain('node_modules');
      expect(stderr).toContain('npm install @zorb/aws');
    } finally {
      cleanup();
    }
  });
});

describe('zorb run — step outputs', () => {
  test('shell step writes key=value to $ZORB_OUTPUT and a later step reads it via env', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  release:
    steps:
      - id: version
        run: echo "tag=v1.2.3" >> "$ZORB_OUTPUT"
      - name: Tag
        env:
          TAG: \${{ steps.version.outputs.tag }}
        run: echo "releasing $TAG"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('releasing v1.2.3');
    } finally {
      cleanup();
    }
  });

  test('shell step heredoc multi-line output is preserved', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  release:
    steps:
      - id: notes
        run: |
          {
            echo 'body<<EOF'
            echo 'line one'
            echo 'line two'
            echo 'EOF'
          } >> "$ZORB_OUTPUT"
      - env:
          BODY: \${{ steps.notes.outputs.body }}
        run: printf '%s' "$BODY"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('line one\nline two');
    } finally {
      cleanup();
    }
  });

  test('shell step with no id discards $ZORB_OUTPUT writes silently', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  noop:
    steps:
      - run: echo "tag=v1" >> "$ZORB_OUTPUT"
      - run: echo done
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'noop'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('done');
    } finally {
      cleanup();
    }
  });

  test('referencing an undefined step output errors', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  release:
    steps:
      - id: version
        run: echo "tag=v1" >> "$ZORB_OUTPUT"
      - env:
          MISSING: \${{ steps.version.outputs.commit }}
        run: echo "$MISSING"
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('undefined step output: steps.version.outputs.commit');
    } finally {
      cleanup();
    }
  });

  test('invalid $ZORB_OUTPUT lines fail the step with a clear error', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  release:
    steps:
      - id: bad
        run: echo 'not an assignment' >> "$ZORB_OUTPUT"
`,
      );
      const { exitCode, stderr } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('invalid line in $ZORB_OUTPUT');
    } finally {
      cleanup();
    }
  });

  test('action step output flows into a later shell step via env', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'tag.action.cjs'),
        `module.exports.action = (inputs, ctx) => ({ tag: 'v9.9.9', count: 3 });\n`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  release:
    steps:
      - id: v
        uses: ./tag.action
      - env:
          TAG: \${{ steps.v.outputs.tag }}
          COUNT: \${{ steps.v.outputs.count }}
        run: echo "tag=$TAG count=$COUNT"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'release'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('tag=v9.9.9 count=3');
    } finally {
      cleanup();
    }
  });
});

describe('zorb run — docker steps', () => {
  // We can't depend on a real Docker daemon in CI, so we drop a fake `docker`
  // script in a temp dir and prepend that dir to PATH for the CLI subprocess.
  // The shim records its argv (and optionally writes to the ZORB_OUTPUT mount)
  // so we can assert what the CLI handed to docker.
  function setupFakeDocker(dir: string, body: string): { pathEnv: string; argvLog: string } {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const argvLog = join(dir, 'docker.argv');
    const shim = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> '${argvLog}'; done
${body}
`;
    writeFileSync(join(binDir, 'docker'), shim, { mode: 0o755 });
    return { pathEnv: `${binDir}:${process.env.PATH}`, argvLog };
  }

  test('runs a docker step and propagates a zero exit', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { pathEnv, argvLog } = setupFakeDocker(dir, 'echo "hello from container"; exit 0');
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:\n  d:\n    steps:\n      - docker: alpine:3.20\n        run: echo hi\n`,
      );
      const { exitCode, stdout } = await runCli(['run', 'd'], { cwd: dir, env: { PATH: pathEnv } });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('hello from container');
      const argv = readFileSync(argvLog, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      expect(argv.slice(0, 3)).toEqual(['run', '--rm', '-i']);
      expect(argv).toContain('alpine:3.20');
      expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi']);
    } finally {
      cleanup();
    }
  });

  test('non-zero exit from the container fails the task', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { pathEnv } = setupFakeDocker(dir, 'exit 19');
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  d:\n    steps:\n      - docker: alpine\n        run: 'exit 0'\n`);
      const { exitCode, stderr } = await runCli(['run', 'd'], { cwd: dir, env: { PATH: pathEnv } });
      expect(exitCode).toBe(19);
      expect(stderr).toContain('step 1/1 failed');
      expect(stderr).toContain('exit code 19');
    } finally {
      cleanup();
    }
  });

  test('long form: image + workdir + platform + pull are passed to docker', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { pathEnv, argvLog } = setupFakeDocker(dir, 'exit 0');
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  d:
    steps:
      - docker:
          image: node:20
          workdir: /app
          platform: linux/amd64
          pull: if-not-present
          network: host
          volumes:
            - /host:/container
          entrypoint: /bin/bash
        run: echo hi
`,
      );
      const { exitCode } = await runCli(['run', 'd'], { cwd: dir, env: { PATH: pathEnv } });
      expect(exitCode).toBe(0);
      const argv = readFileSync(argvLog, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      const after = (flag: string) => argv[argv.indexOf(flag) + 1];
      expect(after('--workdir')).toBe('/app');
      expect(after('--platform')).toBe('linux/amd64');
      expect(after('--network')).toBe('host');
      expect(after('--entrypoint')).toBe('/bin/bash');
      expect(after('--pull')).toBe('missing');
      expect(argv).toContain('/host:/container');
      expect(argv).toContain('node:20');
    } finally {
      cleanup();
    }
  });

  test('-e KEY (no value) passes the value of process.env[KEY] through', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { pathEnv, argvLog } = setupFakeDocker(dir, 'exit 0');
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  d:\n    steps:\n      - docker: alpine\n        run: echo hi\n`);
      const { exitCode } = await runCli(['run', 'd', '-e', 'CI'], {
        cwd: dir,
        env: { PATH: pathEnv, CI: 'true' },
      });
      expect(exitCode).toBe(0);
      const argv = readFileSync(argvLog, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      const envPairs = argv
        .map((a, i) => (argv[i - 1] === '-e' ? a : undefined))
        .filter((x): x is string => x !== undefined);
      expect(envPairs).toContain('CI=true');
    } finally {
      cleanup();
    }
  });

  test('-e KEY silently skips when KEY is not set in process.env', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { pathEnv, argvLog } = setupFakeDocker(dir, 'exit 0');
      writeFileSync(join(dir, 'zorb.yml'), `tasks:\n  d:\n    steps:\n      - docker: alpine\n        run: echo hi\n`);
      const { exitCode } = await runCli(['run', 'd', '-e', 'ZORB_NOT_SET'], {
        cwd: dir,
        env: { PATH: pathEnv, ZORB_NOT_SET: undefined },
      });
      expect(exitCode).toBe(0);
      const argv = readFileSync(argvLog, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      const envPairs = argv
        .map((a, i) => (argv[i - 1] === '-e' ? a : undefined))
        .filter((x): x is string => x !== undefined);
      expect(envPairs.some((p) => p.startsWith('ZORB_NOT_SET'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('declared env: is passed via -e, but process.env is NOT leaked into the container', async () => {
    const { dir, cleanup } = tmp();
    try {
      const { pathEnv, argvLog } = setupFakeDocker(dir, 'exit 0');
      writeFileSync(
        join(dir, 'zorb.yml'),
        `env:\n  DECLARED: yes\ntasks:\n  d:\n    steps:\n      - docker: alpine\n        env:\n          STEP_LEVEL: visible\n        run: echo hi\n`,
      );
      const { exitCode } = await runCli(['run', 'd'], {
        cwd: dir,
        env: { PATH: pathEnv, ZORB_LEAK_TEST: 'must-not-appear' },
      });
      expect(exitCode).toBe(0);
      const argv = readFileSync(argvLog, 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      const envPairs = argv
        .map((a, i) => (argv[i - 1] === '-e' ? a : undefined))
        .filter((x): x is string => x !== undefined);
      expect(envPairs).toContain('DECLARED=yes');
      expect(envPairs).toContain('STEP_LEVEL=visible');
      // The developer's shell exports must not bleed into the container.
      expect(envPairs.some((p) => p.startsWith('ZORB_LEAK_TEST='))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('$ZORB_OUTPUT round-trips through the mount and is read back by a later shell step', async () => {
    const { dir, cleanup } = tmp();
    try {
      // The shim simulates a container that writes to $ZORB_OUTPUT by parsing
      // the -v <host>:/zorb-output pair from argv and writing to the host path.
      const { pathEnv } = setupFakeDocker(
        dir,
        `prev=
for arg in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$arg" in
      *:/zorb-output)
        host_path="\${arg%:/zorb-output}"
        echo "tag=v3.2.1" >> "$host_path"
        ;;
    esac
  fi
  prev="$arg"
done
exit 0`,
      );
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  release:
    steps:
      - id: version
        docker: alpine
        run: 'true'
      - env:
          TAG: \${{ steps.version.outputs.tag }}
        run: echo "releasing $TAG"
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'release'], { cwd: dir, env: { PATH: pathEnv } });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('releasing v3.2.1');
    } finally {
      cleanup();
    }
  });
});
