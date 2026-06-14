import { describe, expect, test } from 'bun:test';
import { createColors } from '../src/colors.ts';
import { createLogger, type LogLevel } from '../src/logger.ts';

function capture(level: LogLevel) {
  const colors = createColors(false);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = createLogger(level, colors, {
    stdout: { write: (chunk) => void stdout.push(chunk) },
    stderr: { write: (chunk) => void stderr.push(chunk) },
  });
  return { log, stdout, stderr };
}

describe('createLogger', () => {
  test('normal level emits info/warn/error but not verbose/debug', () => {
    const { log, stdout, stderr } = capture('normal');
    log.debug('a');
    log.verbose('b');
    log.info('c');
    log.warn('d');
    log.error('e');
    expect(stdout).toEqual(['c\n']);
    expect(stderr).toEqual(['warning: d\n', 'error: e\n']);
  });

  test('verbose level adds verbose output', () => {
    const { log, stderr } = capture('verbose');
    log.verbose('x');
    log.debug('y');
    expect(stderr).toEqual(['[verbose] x\n']);
  });

  test('debug level emits everything', () => {
    const { log, stderr } = capture('debug');
    log.verbose('x');
    log.debug('y');
    expect(stderr).toEqual(['[verbose] x\n', '[debug] y\n']);
  });

  test('quiet level still emits errors', () => {
    const { log, stdout, stderr } = capture('quiet');
    log.info('a');
    log.warn('b');
    log.error('c');
    log.hint('d');
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['error: c\n']);
  });

  test('hint writes to stderr at normal level and above', () => {
    const { log, stderr } = capture('normal');
    log.hint('Usage: zorb run <task>');
    expect(stderr).toEqual(['Usage: zorb run <task>\n']);
  });

  test('non-string args are formatted with util.inspect', () => {
    const { log, stderr } = capture('debug');
    log.debug('parsed:', { foo: 'bar' });
    expect(stderr[0]).toContain("[debug] parsed: { foo: 'bar' }\n");
  });
});
