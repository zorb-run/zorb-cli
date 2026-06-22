#!/usr/bin/env bun
import minimist from 'minimist';
import { createColors, shouldColor } from './colors.ts';
import { runInit } from './commands/init.ts';
import { runList } from './commands/list.ts';
import { runRun } from './commands/run.ts';
import { runRunWithWatch } from './commands/run-watch.ts';
import { runUse } from './commands/use.ts';
import { WorkflowError } from './config.ts';
import { EnvFileError, parseEnvFile, parseInlineEnv } from './envfile.ts';
import { ExpressionError } from './expressions.ts';
import { InputError } from './inputs.ts';
import { createLogger, type Logger, type LogLevel } from './logger.ts';
import { COMMAND_HELP, TOP_LEVEL_HELP } from './help.ts';
import { ActionRunError } from './steps/run-action.ts';
import { DurationError } from './utils/duration.ts';
import { getVersionString } from './version.ts';

/**
 * Installs SIGINT/SIGTERM handlers that abort the run via an AbortController.
 * The first signal triggers a graceful shutdown — the in-flight step kills its
 * subprocess and the orchestrator returns 130 (SIGINT) or 143 (SIGTERM). The
 * signal name is the AbortController's reason so callers can branch on it.
 * A second signal forces an immediate exit in case cleanup itself wedges.
 */
function installShutdownHandlers(log: Logger): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  let signalled = false;
  const onSignal = (sig: NodeJS.Signals) => () => {
    if (signalled) {
      // Second hit: bail immediately. 128 + signal number, by convention.
      process.exit(sig === 'SIGTERM' ? 143 : 130);
    }
    signalled = true;
    log.verbose(`received ${sig}, shutting down`);
    controller.abort(sig);
  };
  const onSigint = onSignal('SIGINT');
  const onSigterm = onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}

interface ParsedArgs {
  _: string[];
  help: boolean;
  version: boolean;
  verbose: boolean;
  debug: boolean;
  quiet: boolean;
  noColor: boolean;
  file?: string;
  envFile?: string;
  env: string[];
  with: string[];
  watch?: string;
}

function multiString(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value !== undefined) return [String(value)];
  return [];
}

/**
 * Rejects `--flag=value` and `-x=value` spellings before any other parsing.
 * The CLI accepts only the space-separated form (`--flag value` / `-x value`)
 * for consistency — one spelling per flag, no exceptions. `--with=...` is the
 * one that prompted this; it was the most ambiguous (multi-value), but the
 * rule applies uniformly so users never have to remember which flags honour
 * the equals form.
 */
function rejectEqualsForms(raw: string[]): void {
  for (const arg of raw) {
    if (!arg.startsWith('-') || arg === '-' || arg === '--') continue;
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    const flag = arg.slice(0, eq);
    throw new InputError(`${flag} does not accept '=' — use '${flag} <value>' instead`);
  }
}

/**
 * Pulls `--with` out of the raw argv before minimist sees it. `--with` takes
 * one or more space-separated `key=value` tokens after the flag (e.g.
 * `--with env=prod dry-run=true`) and is not repeatable. The first following
 * token is consumed unconditionally so a missing `=` still surfaces the
 * existing "invalid --with" error; subsequent tokens are consumed only while
 * they look like pairs, so they don't accidentally swallow positional args.
 */
function extractWithArgs(raw: string[]): { withPairs: string[]; remaining: string[] } {
  const withPairs: string[] = [];
  const remaining: string[] = [];
  let seen = false;

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;

    if (arg === '--with') {
      if (seen) throw new InputError(`--with is not repeatable; pass multiple values as 'key=value key=value'`);
      seen = true;
      let consumed = 0;
      while (i + 1 < raw.length) {
        const next = raw[i + 1]!;
        if (next.startsWith('-')) break;
        if (consumed > 0 && !next.includes('=')) break;
        withPairs.push(next);
        consumed++;
        i++;
      }
      if (consumed === 0) throw new InputError(`--with requires at least one key=value pair`);
      continue;
    }

    remaining.push(arg);
  }

  return { withPairs, remaining };
}

function parseArgs(raw: string[]): ParsedArgs {
  rejectEqualsForms(raw);
  const { withPairs, remaining } = extractWithArgs(raw);

  const argv = minimist(remaining, {
    boolean: ['help', 'version', 'verbose', 'debug', 'quiet'],
    string: ['file', 'env-file', 'env', 'watch'],
    alias: { h: 'help', v: 'verbose', f: 'file', e: 'env' },
  });

  // minimist parses `--no-foo` as `foo: false`, so check the raw args
  // explicitly to detect `--no-color` reliably.
  const noColor = raw.includes('--no-color');

  return {
    _: argv._.map(String),
    help: Boolean(argv.help),
    version: Boolean(argv.version),
    verbose: Boolean(argv.verbose),
    debug: Boolean(argv.debug),
    quiet: Boolean(argv.quiet),
    noColor,
    file: typeof argv.file === 'string' ? argv.file : undefined,
    envFile: typeof argv['env-file'] === 'string' ? argv['env-file'] : undefined,
    env: multiString(argv['env']),
    with: withPairs,
    watch: typeof argv.watch === 'string' ? argv.watch : undefined,
  };
}

function pickLogLevel(args: ParsedArgs): LogLevel {
  if (args.quiet) return 'quiet';
  if (args.debug) return 'debug';
  if (args.verbose) return 'verbose';
  return 'normal';
}

export async function main(rawArgs: string[]): Promise<number> {
  const noColorEarly = rawArgs.includes('--no-color');
  const earlyColors = createColors(shouldColor({ noColorFlag: noColorEarly }));

  let args: ParsedArgs;
  try {
    args = parseArgs(rawArgs);
  } catch (e) {
    if (e instanceof InputError) {
      const log = createLogger('normal', earlyColors);
      log.error(e.message);
      return 1;
    }
    throw e;
  }
  const colors = createColors(shouldColor({ noColorFlag: args.noColor }));
  const log = createLogger(pickLogLevel(args), colors);

  if (args.version) {
    console.log(getVersionString());
    return 0;
  }

  const [command, ...rest] = args._;

  if (!command) {
    console.log(TOP_LEVEL_HELP);
    return 0;
  }

  const wantsHelpOnly =
    command === 'help' ||
    command === 'init' ||
    (args.help && (command === 'run' || command === 'use' || command === 'list'));

  // Inline env vars (--env-file then -e/--env). This is the only channel by
  // which the developer's shell exports can reach a step — process.env is
  // never inherited by any step (shell, docker, or action). Use `-e KEY` for
  // explicit pass-through.
  const inlineEnv: Record<string, string> = Object.create(null);

  if (!wantsHelpOnly && args.envFile) {
    try {
      const vars = parseEnvFile(args.envFile);
      for (const [k, v] of Object.entries(vars)) inlineEnv[k] = v;
      log.verbose(`loaded ${Object.keys(vars).length} env var(s) from ${args.envFile}`);
    } catch (e) {
      return handleEnvFileError(e, log);
    }
  }

  if (!wantsHelpOnly && args.env.length > 0) {
    try {
      let count = 0;
      for (const pair of args.env) {
        const [key, value] = parseInlineEnv(pair);
        if (value === undefined) {
          // Pass-through form: `-e KEY` takes the value from process.env.
          const passed = process.env[key];
          if (passed === undefined) {
            log.verbose(`-e ${key}: not set in environment, skipping`);
            continue;
          }
          inlineEnv[key] = passed;
        } else {
          inlineEnv[key] = value; // -e overrides --env-file
        }
        count++;
      }
      log.verbose(`set ${count} inline env var(s)`);
    } catch (e) {
      return handleEnvFileError(e, log);
    }
  }

  switch (command) {
    case 'help': {
      const target = rest[0];
      if (!target) {
        console.log(TOP_LEVEL_HELP);
        return 0;
      }
      const text = COMMAND_HELP[target];
      if (!text) {
        log.error(`unknown command: ${target}`);
        log.hint(`Run '${colors.bold('zorb help')}' for a list of commands.`);
        return 1;
      }
      console.log(text);
      return 0;
    }

    case 'init': {
      if (args.help) {
        console.log(COMMAND_HELP.init);
        return 0;
      }
      return runInit({ log, colors });
    }

    case 'run': {
      if (args.help) {
        console.log(COMMAND_HELP.run);
        return 0;
      }
      const task = rest[0];
      if (!task) {
        log.error(`'zorb run' requires a task name`);
        log.hint(`Usage: ${colors.bold('zorb run <task>')}`);
        log.hint(`Run '${colors.bold('zorb help run')}' for details.`);
        return 1;
      }
      const shutdown = installShutdownHandlers(log);
      try {
        if (args.watch) {
          return await runRunWithWatch({
            log,
            colors,
            file: args.file,
            taskName: task,
            withPairs: args.with,
            inlineEnv,
            shutdownSignal: shutdown.signal,
            watchGlob: args.watch,
          });
        }
        return await runRun({
          log,
          colors,
          file: args.file,
          taskName: task,
          withPairs: args.with,
          inlineEnv,
          shutdownSignal: shutdown.signal,
        });
      } catch (e) {
        return handleRunError(e, log);
      } finally {
        shutdown.dispose();
      }
    }

    case 'use': {
      if (args.help) {
        console.log(COMMAND_HELP.use);
        return 0;
      }
      const action = rest[0];
      if (!action) {
        log.error(`'zorb use' requires an action`);
        log.hint(`Usage: ${colors.bold('zorb use <action>')}`);
        log.hint(`Run '${colors.bold('zorb help use')}' for details.`);
        return 1;
      }
      const shutdown = installShutdownHandlers(log);
      try {
        return await runUse({
          log,
          colors,
          file: args.file,
          action,
          withPairs: args.with,
          inlineEnv,
          shutdownSignal: shutdown.signal,
        });
      } catch (e) {
        return handleRunError(e, log);
      } finally {
        shutdown.dispose();
      }
    }

    case 'list': {
      if (args.help) {
        console.log(COMMAND_HELP.list);
        return 0;
      }
      try {
        return runList({ log, colors, file: args.file });
      } catch (e) {
        return handleWorkflowError(e, log);
      }
    }

    default: {
      log.error(`unknown command: ${command}`);
      log.hint(`Run '${colors.bold('zorb help')}' for usage.`);
      return 1;
    }
  }
}

function handleWorkflowError(e: unknown, log: Logger): number {
  if (e instanceof WorkflowError) {
    log.error(e.format());
    return 1;
  }
  throw e;
}

function handleEnvFileError(e: unknown, log: Logger): number {
  if (e instanceof EnvFileError) {
    const at = e.line !== undefined ? `\n  at ${e.file}:${e.line}` : `\n  at ${e.file}`;
    log.error(`${e.message}${at}`);
    return 1;
  }
  throw e;
}

function handleRunError(e: unknown, log: Logger): number {
  if (e instanceof WorkflowError) return handleWorkflowError(e, log);
  if (
    e instanceof InputError ||
    e instanceof ExpressionError ||
    e instanceof ActionRunError ||
    e instanceof DurationError
  ) {
    log.error(e.message);
    return 1;
  }
  throw e;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
