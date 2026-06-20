interface KillableProc {
  kill: (sig?: NodeJS.Signals | number) => void;
  exitCode: number | null;
}

// Connect an AbortSignal to a Bun subprocess. On abort, send SIGTERM and
// schedule SIGKILL after a grace period so well-behaved processes get a chance
// to clean up but a hung one is still terminated. Returns a detach function the
// caller must invoke once the process has exited to avoid leaking listeners.
export function attachProcessAbort(proc: KillableProc, signal: AbortSignal | undefined, graceMs: number): () => void {
  if (!signal) return () => {};

  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // already exited
    }
    killTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } catch {
        // already exited
      }
    }, graceMs);
    (killTimer as { unref?: () => void }).unref?.();
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return () => {
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener('abort', onAbort);
  };
}

// AbortSignal.any was added in Node 20.3+ / Bun. Tiny polyfill for safety.
export function anySignal(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => s !== undefined);
  // Native path: cheap & propagates reasons.
  const Any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof Any === 'function') return Any(filtered);
  const controller = new AbortController();
  const onAbort = (sig: AbortSignal) => () => {
    if (controller.signal.aborted) return;
    controller.abort(sig.reason);
  };
  for (const s of filtered) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', onAbort(s), { once: true });
  }
  return controller.signal;
}
