import { describe, expect, test } from 'bun:test';
import { createColors, shouldColor } from '../src/colors.ts';

describe('createColors', () => {
  test('emits ANSI codes when enabled', () => {
    const c = createColors(true);
    expect(c.red('hi')).toBe('\x1b[31mhi\x1b[0m');
    expect(c.bold('hi')).toBe('\x1b[1mhi\x1b[0m');
  });

  test('passes strings through unchanged when disabled', () => {
    const c = createColors(false);
    expect(c.red('hi')).toBe('hi');
    expect(c.bold('hi')).toBe('hi');
  });

  test('exposes the enabled flag', () => {
    expect(createColors(true).enabled).toBe(true);
    expect(createColors(false).enabled).toBe(false);
  });
});

describe('shouldColor', () => {
  test('--no-color wins over everything', () => {
    expect(shouldColor({ noColorFlag: true, env: { FORCE_COLOR: '1' }, isTTY: true })).toBe(false);
  });

  test('NO_COLOR=any-non-empty disables colour', () => {
    expect(shouldColor({ env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
    expect(shouldColor({ env: { NO_COLOR: 'true' }, isTTY: true })).toBe(false);
  });

  test('empty NO_COLOR does not disable', () => {
    expect(shouldColor({ env: { NO_COLOR: '' }, isTTY: true })).toBe(true);
  });

  test('FORCE_COLOR overrides isTTY=false', () => {
    expect(shouldColor({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true);
  });

  test('FORCE_COLOR=0 does not force colour', () => {
    expect(shouldColor({ env: { FORCE_COLOR: '0' }, isTTY: false })).toBe(false);
  });

  test('falls back to isTTY when no flags or env vars set', () => {
    expect(shouldColor({ env: {}, isTTY: true })).toBe(true);
    expect(shouldColor({ env: {}, isTTY: false })).toBe(false);
  });
});
