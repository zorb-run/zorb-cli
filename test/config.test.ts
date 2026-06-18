import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWorkflowFile, loadWorkflow, parseWorkflow, WorkflowError } from '../src/config.ts';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-config-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function expectError(fn: () => void): WorkflowError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorkflowError) return e;
    throw e;
  }
  throw new Error('expected WorkflowError, got no error');
}

describe('parseWorkflow — happy paths', () => {
  test('minimal workflow', () => {
    const wf = parseWorkflow(`tasks:\n  build:\n    steps:\n      - run: echo hi`);
    expect(wf.version).toBe(1);
    expect(Object.keys(wf.tasks)).toEqual(['build']);
    const step = wf.tasks.build!.steps[0]!;
    expect('run' in step && step.run).toBe('echo hi');
  });

  test('full shape with inputs, defaults, env, uses', () => {
    const wf = parseWorkflow(`
version: 1
defaults:
  run:
    shell: /bin/bash
env:
  GLOBAL: yes
tasks:
  deploy:
    description: Deploy it
    inputs:
      env:
        description: Target environment
        type: string
        required: true
      dry-run:
        type: boolean
        default: false
    env:
      TARGET: production
    steps:
      - id: version
        uses: ./version.action
        with:
          tag: v1
      - name: Apply
        run: kubectl apply -f .
`);
    expect(wf.defaults?.run?.shell).toBe('/bin/bash');
    expect(wf.env?.GLOBAL).toBe('yes');
    const task = wf.tasks.deploy!;
    expect(task.inputs?.env?.required).toBe(true);
    expect(task.inputs?.['dry-run']?.default).toBe(false);
    expect(task.steps).toHaveLength(2);
  });

  test('docker short and long form', () => {
    const wf = parseWorkflow(`
tasks:
  c:
    steps:
      - run: echo hi
        docker: postgres:16
      - run: echo bye
        docker:
          image: node:20-alpine
          volumes: ["./src:/app/src"]
          pull: if-not-present
`);
    const [a, b] = wf.tasks.c!.steps as Array<{ docker?: unknown }>;
    expect(a!.docker).toBe('postgres:16');
    expect(b!.docker).toMatchObject({ image: 'node:20-alpine', pull: 'if-not-present' });
  });
});

describe('parseWorkflow — strict validation', () => {
  test('unknown top-level key with did-you-mean hint', () => {
    const e = expectError(() => parseWorkflow(`verison: 1\ntasks: {}`, 'wf.yml'));
    expect(e.message).toContain("unknown key 'verison'");
    expect(e.hint).toBe("did you mean 'version'?");
    expect(e.file).toBe('wf.yml');
    expect(e.line).toBe(1);
  });

  test('unknown step key (the setp: typo)', () => {
    const e = expectError(() => parseWorkflow(`tasks:\n  build:\n    setps:\n      - run: foo`, 'wf.yml'));
    expect(e.message).toContain("unknown key 'setps'");
    expect(e.hint).toBe("did you mean 'steps'?");
  });

  test('step missing both run and uses', () => {
    const e = expectError(() => parseWorkflow(`tasks:\n  b:\n    steps:\n      - name: foo`));
    expect(e.message).toContain(`must define either 'run' or 'uses'`);
  });

  test('step with both run and uses', () => {
    const e = expectError(() => parseWorkflow(`tasks:\n  b:\n    steps:\n      - run: foo\n        uses: bar`));
    expect(e.message).toContain(`cannot define both 'run' and 'uses'`);
  });

  test('with: only allowed on uses steps', () => {
    const e = expectError(() =>
      parseWorkflow(`tasks:\n  b:\n    steps:\n      - run: foo\n        with:\n          x: y`),
    );
    expect(e.message).toContain("unknown key 'with'");
  });

  test('cwd: only allowed on run steps', () => {
    const e = expectError(() => parseWorkflow(`tasks:\n  b:\n    steps:\n      - uses: ./action\n        cwd: /tmp`));
    expect(e.message).toContain("unknown key 'cwd'");
  });

  test('missing required tasks', () => {
    const e = expectError(() => parseWorkflow(`env:\n  X: "ok"`));
    expect(e.message).toContain("missing required key 'tasks'");
  });

  test('empty tasks map', () => {
    const e = expectError(() => parseWorkflow(`tasks: {}`));
    expect(e.message).toContain('must define at least one task');
  });

  test('duplicate step id', () => {
    const e = expectError(() =>
      parseWorkflow(`tasks:\n  b:\n    steps:\n      - id: x\n        run: a\n      - id: x\n        run: b`),
    );
    expect(e.message).toContain("duplicate step id 'x'");
  });

  test('invalid task name', () => {
    const e = expectError(() => parseWorkflow(`tasks:\n  "123bad":\n    steps:\n      - run: foo`));
    expect(e.message).toContain("invalid task name '123bad'");
  });

  test('invalid input type', () => {
    const e = expectError(() =>
      parseWorkflow(`tasks:\n  b:\n    inputs:\n      x:\n        type: blob\n    steps:\n      - run: foo`),
    );
    expect(e.message).toContain('must be one of: string, number, boolean');
  });

  test('unsupported version', () => {
    const e = expectError(() => parseWorkflow(`version: 2\ntasks:\n  b:\n    steps:\n      - run: foo`));
    expect(e.message).toContain('unsupported workflow version: 2');
  });

  test('wrong scalar type', () => {
    const e = expectError(() => parseWorkflow(`tasks:\n  b:\n    description: 123\n    steps:\n      - run: foo`));
    expect(e.message).toContain('must be a string');
  });

  test('docker pull enum', () => {
    const e = expectError(() =>
      parseWorkflow(`
tasks:
  c:
    steps:
      - run: foo
        docker:
          image: x
          pull: maybe
`),
    );
    expect(e.message).toContain('must be one of: always, never, if-not-present');
  });

  test('empty file errors clearly', () => {
    const e = expectError(() => parseWorkflow(``));
    expect(e.message).toContain('empty');
  });

  test('non-map root errors clearly', () => {
    const e = expectError(() => parseWorkflow(`- not a map`));
    expect(e.message).toContain('must be a map');
  });
});

describe('parseWorkflow — secrets: block', () => {
  test('workflow without secrets: parses fine (secrets is undefined)', () => {
    const wf = parseWorkflow(`tasks:\n  b:\n    steps:\n      - run: echo hi`);
    expect(wf.secrets).toBeUndefined();
  });

  test('secrets: block with a valid uses: step', () => {
    const wf = parseWorkflow(`
secrets:
  - uses: "@zorb/secrets/load-1password"
    with:
      vault: Production
tasks:
  b:
    steps:
      - run: echo hi
`);
    expect(wf.secrets).toHaveLength(1);
    expect(wf.secrets![0]!.uses).toBe('@zorb/secrets/load-1password');
    expect(wf.secrets![0]!.with).toEqual({ vault: 'Production' });
  });

  test('secrets: block with multiple uses: steps', () => {
    const wf = parseWorkflow(`
secrets:
  - uses: "@zorb/secrets/load-1password"
  - uses: "@zorb/secrets/load-dotenv"
    with:
      path: .env.local
tasks:
  b:
    steps:
      - run: echo hi
`);
    expect(wf.secrets).toHaveLength(2);
  });

  test('secrets: step with run: is rejected', () => {
    const e = expectError(() =>
      parseWorkflow(`
secrets:
  - run: echo secret
tasks:
  b:
    steps:
      - run: echo hi
`),
    );
    expect(e.message).toContain("'run:' is not allowed in the 'secrets:' block");
    expect(e.hint).toContain('uses:');
  });

  test('secrets: step with docker: is rejected', () => {
    const e = expectError(() =>
      parseWorkflow(`
secrets:
  - docker: alpine
    uses: ./action
tasks:
  b:
    steps:
      - run: echo hi
`),
    );
    expect(e.message).toContain("'docker:' is not allowed in the 'secrets:' block");
  });

  test('secrets: step missing uses: is rejected', () => {
    const e = expectError(() =>
      parseWorkflow(`
secrets:
  - name: load
tasks:
  b:
    steps:
      - run: echo hi
`),
    );
    expect(e.message).toContain("must define 'uses:'");
  });
});

describe('WorkflowError.format', () => {
  test('includes file, line, col, and hint', () => {
    const e = new WorkflowError('boom', 'wf.yml', 5, 2, 'try X');
    expect(e.format()).toBe(`boom\n  at wf.yml:5:2\n  hint: try X`);
  });

  test('omits missing pieces gracefully', () => {
    expect(new WorkflowError('boom', '', undefined, undefined, undefined).format()).toBe('boom');
    expect(new WorkflowError('boom', 'wf.yml').format()).toBe('boom\n  at wf.yml');
  });
});

describe('findWorkflowFile', () => {
  test('finds zorb.yml in cwd', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb.yml'), 'tasks:\n  b:\n    steps:\n      - run: x');
      expect(findWorkflowFile({ cwd: dir })).toBe(join(dir, 'zorb.yml'));
    } finally {
      cleanup();
    }
  });

  test('walks up to find zorb.yml in a parent', () => {
    const { dir, cleanup } = tmp();
    try {
      const deep = join(dir, 'a/b/c');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(dir, 'zorb.yml'), 'tasks:\n  b:\n    steps:\n      - run: x');
      expect(findWorkflowFile({ cwd: deep })).toBe(join(dir, 'zorb.yml'));
    } finally {
      cleanup();
    }
  });

  test('returns undefined when no zorb.yml is found', () => {
    const { dir, cleanup } = tmp();
    try {
      expect(findWorkflowFile({ cwd: dir })).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe('loadWorkflow', () => {
  test('uses --file directly when provided', () => {
    const { dir, cleanup } = tmp();
    try {
      const file = join(dir, 'custom.yml');
      writeFileSync(file, 'tasks:\n  build:\n    steps:\n      - run: hi');
      const { workflow, path } = loadWorkflow({ file });
      expect(path).toBe(file);
      expect(Object.keys(workflow.tasks)).toEqual(['build']);
    } finally {
      cleanup();
    }
  });

  test('errors when --file does not exist', () => {
    const e = expectError(() => loadWorkflow({ file: '/this/does/not/exist.yml' }));
    expect(e.message).toContain('workflow file not found');
  });

  test('errors when no zorb.yml found anywhere', () => {
    const { dir, cleanup } = tmp();
    try {
      const e = expectError(() => loadWorkflow({ cwd: dir }));
      expect(e.message).toContain("couldn't find zorb.yml");
      expect(e.hint).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
