/**
 * Public API for action authors. Imported via `zorb/action`.
 *
 * Actions are user code that the runner invokes with raw inputs and a context
 * object. This module exports the types describing that contract plus a small
 * validation helper.
 */

/** Raw `with:` payload passed to an action function. Always `unknown` — validate before use. */
export type ActionInput = unknown;

type ActionOutputItem =
  | string
  | number
  | boolean
  | (string | number | boolean)[]
  | Record<string, string | number | boolean>;
/** Expected action result */
export type ActionOutput = ActionOutputItem | Promise<ActionOutputItem>;

/** Second argument to an action function. Shape matches the JS/TS runner contract. */
export interface ActionContext {
  cwd: string;
  taskName: string;
  stepId?: string;
  /** Shared logger to print output. */
  log: {
    debug(msg: unknown): void;
    info(msg: unknown): void;
    warn(msg: unknown): void;
    error(msg: unknown): void;
  };
  /** Register a run-scoped secret; masked anywhere it appears in later step output. */
  setSecret(name: string, value: string): void;
  /** Register an env var for subsequent steps in this run. */
  setEnv(name: string, value: string): void;
}
