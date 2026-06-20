import { describe, expect, test } from 'bun:test';
import { DurationError, parseDuration } from '../src/utils/duration.ts';

describe('parseDuration', () => {
  test('parses milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1ms')).toBe(1);
  });

  test('parses seconds', () => {
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('30s')).toBe(30_000);
  });

  test('parses minutes and hours', () => {
    expect(parseDuration('5m')).toBe(5 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
  });

  test('accepts decimals', () => {
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('0.5m')).toBe(30_000);
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseDuration(' 30s ')).toBe(30_000);
  });

  test('rejects bare numbers', () => {
    expect(() => parseDuration('30')).toThrow(DurationError);
  });

  test('rejects unknown units', () => {
    expect(() => parseDuration('5d')).toThrow(DurationError);
    expect(() => parseDuration('1min')).toThrow(DurationError);
  });

  test('rejects compound forms', () => {
    expect(() => parseDuration('1m30s')).toThrow(DurationError);
  });

  test('rejects zero and negative durations', () => {
    expect(() => parseDuration('0s')).toThrow(DurationError);
    expect(() => parseDuration('-5s')).toThrow(DurationError);
  });

  test('error mentions the offending input', () => {
    try {
      parseDuration('nope');
    } catch (e) {
      expect((e as Error).message).toContain('"nope"');
      return;
    }
    throw new Error('expected throw');
  });
});
