import { describe, expect, test } from 'bun:test';
import { RunContext } from '../src/context.ts';

describe('RunContext — secrets', () => {
  test('setSecret stores a value and hasSecret returns true', () => {
    const ctx = new RunContext();
    expect(ctx.hasSecret('TOKEN')).toBe(false);
    ctx.setSecret('TOKEN', 'abc123');
    expect(ctx.hasSecret('TOKEN')).toBe(true);
  });

  test('setSecret returns true on first registration', () => {
    const ctx = new RunContext();
    expect(ctx.setSecret('TOKEN', 'abc123')).toBe(true);
  });

  test('setSecret returns false and is a no-op on subsequent registrations (first-one-wins)', () => {
    const ctx = new RunContext();
    ctx.setSecret('TOKEN', 'first');
    expect(ctx.setSecret('TOKEN', 'second')).toBe(false);
    expect(ctx.getSecretsSnapshot().TOKEN).toBe('first');
  });

  test('getSecretsSnapshot returns a plain object of all registered secrets', () => {
    const ctx = new RunContext();
    ctx.setSecret('A', '1');
    ctx.setSecret('B', '2');
    expect(ctx.getSecretsSnapshot()).toEqual({ A: '1', B: '2' });
  });

  test('getSecretsSnapshot is a snapshot — mutations do not affect the context', () => {
    const ctx = new RunContext();
    ctx.setSecret('X', 'val');
    const snap = ctx.getSecretsSnapshot();
    snap['X'] = 'mutated';
    expect(ctx.getSecretsSnapshot().X).toBe('val');
  });

  test('hasSecrets is false when no secrets are registered', () => {
    expect(new RunContext().hasSecrets).toBe(false);
  });

  test('hasSecrets is true after at least one registration', () => {
    const ctx = new RunContext();
    ctx.setSecret('A', 'x');
    expect(ctx.hasSecrets).toBe(true);
  });
});

describe('RunContext — mask', () => {
  test('returns text unchanged when no secrets are registered', () => {
    expect(new RunContext().mask('hello world')).toBe('hello world');
  });

  test('replaces a registered secret value with ***', () => {
    const ctx = new RunContext();
    ctx.setSecret('TOKEN', 'supersecret');
    expect(ctx.mask('token is supersecret here')).toBe('token is *** here');
  });

  test('replaces all occurrences of a secret in one string', () => {
    const ctx = new RunContext();
    ctx.setSecret('PW', 'pass');
    expect(ctx.mask('pass and pass again')).toBe('*** and *** again');
  });

  test('masks multiple registered secrets', () => {
    const ctx = new RunContext();
    ctx.setSecret('A', 'foo');
    ctx.setSecret('B', 'bar');
    expect(ctx.mask('foo and bar')).toBe('*** and ***');
  });

  test('does not mask empty-string secrets (zero-length guard)', () => {
    const ctx = new RunContext();
    ctx.setSecret('EMPTY', '');
    expect(ctx.mask('hello')).toBe('hello');
  });
});

describe('RunContext — dynamic env', () => {
  test('getDynamicEnv returns empty object when nothing registered', () => {
    expect(new RunContext().getDynamicEnv()).toEqual({});
  });

  test('setEnv registers a value visible via getDynamicEnv', () => {
    const ctx = new RunContext();
    ctx.setEnv('FOO', 'bar');
    expect(ctx.getDynamicEnv()).toEqual({ FOO: 'bar' });
  });

  test('setEnv overwrites earlier value for the same key', () => {
    const ctx = new RunContext();
    ctx.setEnv('K', 'first');
    ctx.setEnv('K', 'second');
    expect(ctx.getDynamicEnv().K).toBe('second');
  });

  test('getDynamicEnv is a snapshot — mutations do not affect the context', () => {
    const ctx = new RunContext();
    ctx.setEnv('X', 'original');
    const snap = ctx.getDynamicEnv();
    snap['X'] = 'mutated';
    expect(ctx.getDynamicEnv().X).toBe('original');
  });
});
