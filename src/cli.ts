#!/usr/bin/env bun
import minimist from 'minimist';
import { createColors, shouldColor } from './colors.ts';
import { runList } from './commands/list.ts';
import { WorkflowError } from './config.ts';
import { applyEnv, EnvFileError, parseEnvFile, parseInlineEnv } from './envfile.ts';
import { createLogger, type Logger, type LogLevel } from './logger.ts';
import { COMMAND_HELP, TOP_LEVEL_HELP } from './help.ts';
import { getVersionString } from './version.ts';

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

function parseArgs(raw: string[]): ParsedArgs {
  const argv = minimist(raw, {
    boolean: ['help', 'version', 'verbose', 'debug', 'quiet'],
    string: ['file', 'env-file', 'env', 'with', 'watch'],
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
    with: multiString(argv['with']),
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
  const args = parseArgs(rawArgs);
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
    (args.help && (command === 'run' || command === 'use' || command === 'list'));

  if (!wantsHelpOnly && args.envFile) {
    try {
      const vars = parseEnvFile(args.envFile);
      applyEnv(vars);
      log.verbose(`loaded ${Object.keys(vars).length} env var(s) from ${args.envFile}`);
    } catch (e) {
      return handleEnvFileError(e, log);
    }
  }

  if (!wantsHelpOnly && args.env.length > 0) {
    try {
      const inline: Record<string, string> = {};
      for (const pair of args.env) {
        const [key, value] = parseInlineEnv(pair);
        inline[key] = value;
      }
      applyEnv(inline, process.env, { override: true });
      log.verbose(`set ${Object.keys(inline).length} inline env var(s)`);
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
      log.debug(`parsed args:`, args);
      log.verbose(`would run task '${task}' with ${args.with.length} input(s)`);
      log.info(colors.dim(`(scaffold) zorb run ${task} — execution not yet implemented`));
      return 0;
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
      log.debug(`parsed args:`, args);
      log.verbose(`would run action '${action}' with ${args.with.length} input(s)`);
      log.info(colors.dim(`(scaffold) zorb use ${action} — execution not yet implemented`));
      return 0;
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

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
