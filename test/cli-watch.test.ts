import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

interface WatchProc {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Concatenated stdout. */
  stdout(): string;
  /** Concatenated stderr. */
  stderr(): string;
  /** Wait until `combined()` contains `needle` at least `count` times. Rejects on timeout. */
  waitFor(needle: string, opts?: { count?: number; timeoutMs?: number }): Promise<void>;
  /** Send SIGINT and wait for the process to exit, returning the exit code. */
  shutdown(): Promise<number>;
}

function startWatch(args: string[], cwd: string): WatchProc {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.NO_COLOR = '1';

  const proc = Bun.spawn({
    cmd: ['bun', CLI, ...args],
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let outBuf = '';
  let errBuf = '';
  const waiters: Array<() => void> = [];
  const notify = () => {
    const snapshot = waiters.splice(0, waiters.length);
    for (const w of snapshot) w();
  };

  const pump = async (stream: ReadableStream<Uint8Array>, append: (chunk: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      append(decoder.decode(chunk));
      notify();
    }
  };
  // Fire and forget — the streams close when the subprocess exits.
  void pump(proc.stdout, (s) => {
    outBuf += s;
  });
  void pump(proc.stderr, (s) => {
    errBuf += s;
  });

  return {
    proc,
    stdout: () => outBuf,
    stderr: () => errBuf,
    async waitFor(needle, { count = 1, timeoutMs = 5000 } = {}) {
      const start = Date.now();
      const countOccurrences = () => {
        const combined = outBuf + errBuf;
        let n = 0;
        let i = 0;
        while ((i = combined.indexOf(needle, i)) !== -1) {
          n++;
          i += needle.length;
        }
        return n;
      };
      while (countOccurrences() < count) {
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) {
          throw new Error(
            `timed out waiting for ${JSON.stringify(needle)} (count ${count}). stdout:\n${outBuf}\nstderr:\n${errBuf}`,
          );
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(
            () => {
              const idx = waiters.indexOf(resolve);
              if (idx >= 0) waiters.splice(idx, 1);
              resolve();
            },
            Math.min(remaining, 250),
          );
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    async shutdown() {
      proc.kill('SIGINT');
      await proc.exited;
      return proc.exitCode ?? -1;
    },
  };
}

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-watch-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Use a distinct step name and a distinct echo marker so the step-label line
// and the actual output use different tokens. That way counting occurrences of
// MARK in stdout maps 1:1 onto runs of the task.
const MARK = 'PINGOUT';
function writeWorkflow(dir: string) {
  writeFileSync(
    join(dir, 'zorb.yml'),
    `tasks:
  tick:
    steps:
      - name: ping
        run: echo ${MARK}
`,
  );
}

describe('zorb run --watch', () => {
  test('runs the task once on startup', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeWorkflow(dir);
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.txt'), 'hello');

      const wp = startWatch(['run', 'tick', '--watch', 'src/**/*.txt'], dir);
      try {
        await wp.waitFor(MARK, { timeoutMs: 8000 });
        await wp.waitFor('watching for changes', { timeoutMs: 8000 });
      } finally {
        await wp.shutdown();
      }
    } finally {
      cleanup();
    }
  });

  test('re-runs the task when a matching file changes', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeWorkflow(dir);
      mkdirSync(join(dir, 'src'));
      const target = join(dir, 'src', 'a.txt');
      writeFileSync(target, 'one');

      const wp = startWatch(['run', 'tick', '--watch', 'src/**/*.txt'], dir);
      try {
        await wp.waitFor(MARK, { timeoutMs: 8000 });
        await wp.waitFor('watching for changes', { timeoutMs: 8000 });

        // Trigger a change and expect a second run.
        writeFileSync(target, 'two');
        await wp.waitFor('changed: src/a.txt', { timeoutMs: 8000 });
        await wp.waitFor(MARK, { count: 2, timeoutMs: 8000 });
      } finally {
        await wp.shutdown();
      }
    } finally {
      cleanup();
    }
  });

  test('ignores changes that do not match the glob', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeWorkflow(dir);
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'src', 'a.txt'), 'one');

      const wp = startWatch(['run', 'tick', '--watch', 'src/**/*.txt'], dir);
      try {
        await wp.waitFor(MARK, { timeoutMs: 8000 });
        await wp.waitFor('watching for changes', { timeoutMs: 8000 });

        // Touching an unrelated file should NOT trigger a re-run.
        writeFileSync(join(dir, 'docs', 'README.md'), 'irrelevant');
        await new Promise((r) => setTimeout(r, 500));
        // Only the initial run so far.
        const runs = wp.stdout().split(MARK).length - 1;
        expect(runs).toBe(1);
      } finally {
        await wp.shutdown();
      }
    } finally {
      cleanup();
    }
  });

  test('exits cleanly on SIGINT', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeWorkflow(dir);
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.txt'), 'hello');

      const wp = startWatch(['run', 'tick', '--watch', 'src/**/*.txt'], dir);
      await wp.waitFor('watching for changes', { timeoutMs: 8000 });
      const code = await wp.shutdown();
      expect(code).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('exits with 143 on SIGTERM so orchestrators can detect it', async () => {
    const { dir, cleanup } = tmp();
    try {
      writeWorkflow(dir);
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.txt'), 'hello');

      const wp = startWatch(['run', 'tick', '--watch', 'src/**/*.txt'], dir);
      try {
        await wp.waitFor('watching for changes', { timeoutMs: 8000 });
        wp.proc.kill('SIGTERM');
        await wp.proc.exited;
        expect(wp.proc.exitCode).toBe(143);
      } finally {
        // Make sure the process is gone even if assertions fail.
        if (wp.proc.exitCode === null) wp.proc.kill('SIGKILL');
      }
    } finally {
      cleanup();
    }
  });
});
