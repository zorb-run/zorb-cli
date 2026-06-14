import { inspect } from 'node:util';
import type { Colors } from './colors.ts';

export type LogLevel = 'quiet' | 'normal' | 'verbose' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = {
  quiet: 0,
  normal: 1,
  verbose: 2,
  debug: 3,
};

export interface Logger {
  level: LogLevel;
  colors: Colors;
  debug(...args: unknown[]): void;
  verbose(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  hint(...args: unknown[]): void;
}

export interface LoggerStreams {
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
}

function format(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ') + '\n';
}

// We write to stdout/stderr directly (bypassing console.log/error) because Bun
// auto-colourises console output to stderr when FORCE_COLOR is set, which would
// override --no-color.
export function createLogger(
  level: LogLevel,
  colors: Colors,
  streams: LoggerStreams = { stdout: process.stdout, stderr: process.stderr },
): Logger {
  const at = (target: LogLevel) => LEVEL_RANK[level] >= LEVEL_RANK[target];
  return {
    level,
    colors,
    debug(...args) {
      if (at('debug')) streams.stderr.write(format([colors.gray('[debug]'), ...args]));
    },
    verbose(...args) {
      if (at('verbose')) streams.stderr.write(format([colors.gray('[verbose]'), ...args]));
    },
    info(...args) {
      if (at('normal')) streams.stdout.write(format(args));
    },
    warn(...args) {
      if (at('normal')) streams.stderr.write(format([colors.yellow('warning:'), ...args]));
    },
    error(...args) {
      streams.stderr.write(format([colors.red('error:'), ...args]));
    },
    hint(...args) {
      if (at('normal')) streams.stderr.write(format(args));
    },
  };
}
