import { describe, expect, test } from 'bun:test';
import type { ActionContext, ActionInput, ActionOutput } from '../src/action.ts';

describe('public types', () => {
  test('ActionInput is unknown — must be validated before use', () => {
    const input: ActionInput = { anything: 'goes' };
    expect(input).toBeDefined();
  });

  test('ActionContext shape compiles against a runner-style object', () => {
    const ctx: ActionContext = {
      cwd: '/tmp',
      taskName: 't',
      stepId: 's',
      log: { debug() {}, info() {}, warn() {}, error() {} },
      setSecret() {},
      setEnv() {},
    };
    expect(ctx.taskName).toBe('t');
  });

  test('ActionOutput admits primitives, arrays, records, and their promises', () => {
    const s: ActionOutput = 'str';
    const n: ActionOutput = 1;
    const b: ActionOutput = true;
    const arr: ActionOutput = ['a', 1, false];
    const rec: ActionOutput = { k: 'v', n: 2, ok: true };
    const p: ActionOutput = Promise.resolve({ k: 'v' });
    expect([s, n, b, arr, rec, p]).toHaveLength(6);
  });
});
