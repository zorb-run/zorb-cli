import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeShellStep } from '../src/steps/run-shell.ts';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-runshell-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('executeShellStep', () => {
  test('returns the subprocess exit code', async () => {
    const { dir, cleanup } = tmp();
    try {
      const ok = await executeShellStep({
        run: 'exit 0',
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(ok.exitCode).toBe(0);

      const bad = await executeShellStep({
        run: 'exit 42',
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(bad.exitCode).toBe(42);
    } finally {
      cleanup();
    }
  });

  test('captures stdout and stderr when piped', async () => {
    const { dir, cleanup } = tmp();
    try {
      const result = await executeShellStep({
        run: 'echo hello; echo "to stderr" >&2',
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('to stderr\n');
    } finally {
      cleanup();
    }
  });

  test('passes env vars to the subprocess', async () => {
    const { dir, cleanup } = tmp();
    try {
      const result = await executeShellStep({
        run: 'echo "$FOO/$BAR"; echo "missing:${MISSING_VAR:-unset}"',
        env: { FOO: 'one', BAR: 'two' },
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('one/two');
      // A var we never set should be unset in the child (the shell may
      // default PATH itself, so use a unique var name to avoid that).
      expect(result.stdout).toContain('missing:unset');
    } finally {
      cleanup();
    }
  });

  test('runs in the given cwd', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'marker.txt'), 'present');
      const result = await executeShellStep({
        run: 'cat marker.txt',
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('present');
    } finally {
      cleanup();
    }
  });

  test('handles multi-line scripts as a single -c invocation', async () => {
    const { dir, cleanup } = tmp();
    try {
      const result = await executeShellStep({
        run: `FOO=hi
echo "$FOO"
echo "still in same shell: $FOO"`,
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hi\nstill in same shell: hi\n');
    } finally {
      cleanup();
    }
  });

  test('honours an explicit shell override', async () => {
    const { dir, cleanup } = tmp();
    try {
      const result = await executeShellStep({
        run: 'echo $0',
        env: {},
        cwd: dir,
        shell: '/bin/sh',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout?.trim()).toBe('/bin/sh');
    } finally {
      cleanup();
    }
  });

  test('applies mask function to captured stdout/stderr (pipe mode)', async () => {
    const { dir, cleanup } = tmp();
    try {
      const result = await executeShellStep({
        run: 'echo "password is supersecret"; echo "also supersecret" >&2',
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        mask: (t) => t.split('supersecret').join('***'),
      });
      expect(result.stdout).toBe('password is ***\n');
      expect(result.stderr).toBe('also ***\n');
    } finally {
      cleanup();
    }
  });

  test('mask: undefined leaves output unchanged', async () => {
    const { dir, cleanup } = tmp();
    try {
      const result = await executeShellStep({
        run: 'echo secret',
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        mask: undefined,
      });
      expect(result.stdout).toBe('secret\n');
    } finally {
      cleanup();
    }
  });

  test('does NOT substitute ${{ }} expressions — passes them to the shell verbatim', async () => {
    const { dir, cleanup } = tmp();
    try {
      // The CLI never sends ${{ }} into run:, but the executor is dumb on
      // purpose. Confirm that property here.
      const file = join(dir, 'out.txt');
      const result = await executeShellStep({
        // The shell will write the literal string because ${{ }} is not
        // shell syntax.
        run: `echo '\${{ inputs.foo }}' > ${file}`,
        env: {},
        cwd: dir,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(file, 'utf-8')).toBe('${{ inputs.foo }}\n');
    } finally {
      cleanup();
    }
  });
});
