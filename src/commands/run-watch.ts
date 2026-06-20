import { watch as fsWatch } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { findWorkflowFile, WorkflowError } from '../config.ts';
import { EnvFileError } from '../envfile.ts';
import { ExpressionError } from '../expressions.ts';
import { InputError } from '../inputs.ts';
import type { Logger } from '../logger.ts';
import { ActionRunError } from '../steps/run-action.ts';
import { DurationError } from '../utils/duration.ts';
import { runRun, type RunOptions } from './run.ts';

export interface RunWatchOptions extends RunOptions {
  /** Glob (Bun.Glob syntax) matched against paths relative to the workflow directory. */
  watchGlob: string;
}

const DEBOUNCE_MS = 100;

/**
 * Run a task in watch mode: rerun whenever a file matching `watchGlob` changes
 * under the workflow directory. Rapid changes are debounced and an in-flight
 * run is cancelled (via a per-iteration AbortController combined with the
 * top-level shutdown signal) before the next run starts. Per-iteration errors
 * are printed but don't break the watch — only a top-level shutdown ends it.
 */
export async function runRunWithWatch(opts: RunWatchOptions): Promise<number> {
  const { log, colors, watchGlob, shutdownSignal } = opts;

  const root = resolveWatchRoot(opts);
  if (!root) {
    log.error(`couldn't find zorb.yml in ${process.cwd()} or any parent directory`);
    log.hint(`pass --file <path> or create a zorb.yml`);
    return 1;
  }

  const glob = new Bun.Glob(watchGlob);

  let stopped = false;
  let pending = true;
  let inFlight: AbortController | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeLoop: (() => void) | undefined;

  const wake = () => {
    const w = wakeLoop;
    if (w) {
      wakeLoop = undefined;
      w();
    }
  };

  const onChange = (filename: string | null) => {
    if (!filename || stopped) return;
    // fs.watch can emit platform-native separators on Windows; normalise so
    // Bun.Glob's POSIX-style patterns match consistently.
    const rel = filename.replace(/\\/g, '/');
    if (!glob.match(rel)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      log.info(colors.gray(`> changed: ${rel}`));
      pending = true;
      inFlight?.abort('watch-change');
      wake();
    }, DEBOUNCE_MS);
  };

  let watcher;
  try {
    watcher = fsWatch(root, { recursive: true }, (_event, filename) => onChange(filename));
  } catch (e) {
    log.error(`failed to start watcher on ${root}: ${(e as Error).message}`);
    return 1;
  }

  const onShutdown = () => {
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    inFlight?.abort();
    try {
      watcher.close();
    } catch {
      // already closed
    }
    wake();
  };
  if (shutdownSignal?.aborted) onShutdown();
  else shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

  const displayRoot = relative(process.cwd(), root) || '.';
  log.info(colors.gray(`watching ${watchGlob} in ${displayRoot}`));

  try {
    while (!stopped) {
      if (!pending) {
        await new Promise<void>((resolve) => {
          if (stopped || pending) return resolve();
          wakeLoop = resolve;
        });
        continue;
      }
      pending = false;
      inFlight = new AbortController();
      const { signal, dispose } = combineSignals(shutdownSignal, inFlight.signal);
      try {
        await runRun({ ...opts, shutdownSignal: signal });
      } catch (e) {
        if (!printRunError(e, log)) throw e;
      } finally {
        dispose();
        inFlight = undefined;
      }
      if (!stopped && !pending) log.info(colors.gray(`watching for changes…`));
    }
  } finally {
    shutdownSignal?.removeEventListener('abort', onShutdown);
    try {
      watcher.close();
    } catch {
      // already closed
    }
    if (debounceTimer) clearTimeout(debounceTimer);
  }

  return 0;
}

function resolveWatchRoot(opts: RunOptions): string | undefined {
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (opts.file) {
    const filePath = isAbsolute(opts.file) ? opts.file : resolve(cwd, opts.file);
    return dirname(filePath);
  }
  const found = findWorkflowFile({ cwd });
  return found ? dirname(found) : undefined;
}

interface CombinedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

// Combine two AbortSignals into one without leaking listeners across iterations:
// dispose() detaches the per-iteration listeners so the parent shutdown signal
// doesn't accumulate them over the lifetime of a long watch session.
function combineSignals(parent: AbortSignal | undefined, child: AbortSignal): CombinedSignal {
  if (!parent) return { signal: child, dispose: () => {} };
  const ctl = new AbortController();
  if (parent.aborted) ctl.abort(parent.reason);
  else if (child.aborted) ctl.abort(child.reason);
  const onParent = () => ctl.abort(parent.reason);
  const onChild = () => ctl.abort(child.reason);
  parent.addEventListener('abort', onParent, { once: true });
  child.addEventListener('abort', onChild, { once: true });
  return {
    signal: ctl.signal,
    dispose: () => {
      parent.removeEventListener('abort', onParent);
      child.removeEventListener('abort', onChild);
    },
  };
}

// Mirror the cli.ts boundary handler so a per-iteration error (broken zorb.yml,
// bad inputs, action crash) prints cleanly and the watch loop continues.
// Returns true if the error was recognised and printed; false to let it bubble.
function printRunError(e: unknown, log: Logger): boolean {
  if (e instanceof WorkflowError) {
    log.error(e.format());
    return true;
  }
  if (e instanceof EnvFileError) {
    const at = e.line !== undefined ? `\n  at ${e.file}:${e.line}` : `\n  at ${e.file}`;
    log.error(`${e.message}${at}`);
    return true;
  }
  if (
    e instanceof InputError ||
    e instanceof ExpressionError ||
    e instanceof ActionRunError ||
    e instanceof DurationError
  ) {
    log.error(e.message);
    return true;
  }
  return false;
}
