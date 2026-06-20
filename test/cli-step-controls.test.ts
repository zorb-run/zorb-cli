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
  const dir = mkdtempSync(join(tmpdir(), 'zorb-controls-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('step controls', () => {
  test('timeout fails a long-running step quickly', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  hang:
    steps:
      - name: Hang
        run: exec sleep 10
        timeout: 300ms
`,
      );
      const start = Date.now();
      const { exitCode, stderr } = await runCli(['run', 'hang'], { cwd: dir });
      const elapsed = Date.now() - start;
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('timed out after 300ms');
      expect(elapsed).toBeLessThan(5000);
    } finally {
      cleanup();
    }
  });

  test('retries lets a flake succeed on a later attempt', async () => {
    const { dir, cleanup } = tmp();
    try {
      const counter = join(dir, 'count');
      writeFileSync(counter, '0');
      // Increment a counter each attempt; fail until it reaches 2.
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  flake:
    steps:
      - name: Maybe
        run: |
          n=$(cat ${counter})
          n=$((n+1))
          echo $n > ${counter}
          if [ "$n" -lt 2 ]; then
            echo "failing attempt $n"
            exit 1
          fi
          echo "ok on attempt $n"
        retries: 2
`,
      );
      const { exitCode, stdout } = await runCli(['run', 'flake'], { cwd: dir });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('failing attempt 1');
      expect(stdout).toContain('ok on attempt 2');
      expect(readFileSync(counter, 'utf-8').trim()).toBe('2');
    } finally {
      cleanup();
    }
  });

  test('retries gives up after the attempt count is exhausted', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  doomed:
    steps:
      - name: Doomed
        run: exit 7
        retries: 2
`,
      );
      const { exitCode, stdout, stderr } = await runCli(['run', 'doomed'], { cwd: dir });
      expect(exitCode).toBe(7);
      // Retry banner is program output (stdout); the final failure is on stderr.
      expect(stdout).toContain('retry 1/2');
      expect(stdout).toContain('retry 2/2');
      expect(stderr).toContain('failed with exit code 7');
    } finally {
      cleanup();
    }
  });

  test('exits cleanly on SIGINT and reports shutdown', async () => {
    const { dir, cleanup } = tmp();
    try {
      // Marker file so we can verify the subprocess actually started before we killed it.
      const marker = join(dir, 'started');
      writeFileSync(
        join(dir, 'zorb.yml'),
        `tasks:
  hang:
    steps:
      - run: |
          touch ${marker}
          exec sleep 30
`,
      );
      const baseEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) baseEnv[k] = v;
      }
      baseEnv.NO_COLOR = '1';
      const proc = Bun.spawn({
        cmd: ['bun', CLI, 'run', 'hang'],
        cwd: dir,
        env: baseEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Wait for the marker so we know the subprocess is in `sleep`.
      const start = Date.now();
      while (!existsSync(marker) && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(marker)).toBe(true);

      proc.kill('SIGINT');
      await proc.exited;
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(8000);
      // SHUTDOWN_EXIT_CODE = 130
      expect(proc.exitCode).toBe(130);
    } finally {
      cleanup();
    }
  }, 15000);
});
