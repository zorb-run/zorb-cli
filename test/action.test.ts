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

  test('ActionOutput admits records, nested values, void, and their promises', () => {
    const rec: ActionOutput = { k: 'v', n: 2, ok: true, nothing: null };
    const nested: ActionOutput = { tags: ['a', 'b'], meta: { v: 1, deep: { ok: true } } };
    const v: ActionOutput = undefined;
    const pRec: ActionOutput = Promise.resolve({ k: 'v' });
    const pVoid: ActionOutput = Promise.resolve();
    expect([rec, nested, v, pRec, pVoid]).toHaveLength(5);
  });
});
