import { describe, expect, test } from 'bun:test';
import { coerce, InputError, parseWithPairs, resolveInputs } from '../src/inputs.ts';
import type { Input } from '../src/types.ts';

describe('parseWithPairs', () => {
  test('splits on the first =', () => {
    expect(parseWithPairs(['foo=bar', 'baz=qux'])).toEqual({ foo: 'bar', baz: 'qux' });
  });

  test('preserves trailing =s in the value', () => {
    expect(parseWithPairs(['foo=bar=baz'])).toEqual({ foo: 'bar=baz' });
  });

  test('allows empty values', () => {
    expect(parseWithPairs(['foo='])).toEqual({ foo: '' });
  });

  test('rejects pairs without =', () => {
    expect(() => parseWithPairs(['foo'])).toThrow(InputError);
  });

  test('rejects pairs with no key', () => {
    expect(() => parseWithPairs(['=bar'])).toThrow(InputError);
  });

  test('rejects invalid key names', () => {
    expect(() => parseWithPairs(['1bad=ok'])).toThrow(InputError);
    expect(() => parseWithPairs(['a.b=ok'])).toThrow(InputError);
  });

  test('allows hyphens in keys (matches schema)', () => {
    expect(parseWithPairs(['dry-run=true'])).toEqual({ 'dry-run': 'true' });
  });
});

describe('coerce', () => {
  test('string is identity', () => {
    expect(coerce('hello', 'string')).toBe('hello');
    expect(coerce('', 'string')).toBe('');
  });

  test('defaults to string when type is omitted', () => {
    expect(coerce('42')).toBe('42');
  });

  test('number parses integers and floats', () => {
    expect(coerce('42', 'number')).toBe(42);
    expect(coerce('-1.5', 'number')).toBe(-1.5);
  });

  test('number rejects garbage', () => {
    expect(() => coerce('abc', 'number')).toThrow(InputError);
    expect(() => coerce('', 'number')).toThrow(InputError);
    expect(() => coerce('NaN', 'number')).toThrow(InputError);
    expect(() => coerce('Infinity', 'number')).toThrow(InputError);
  });

  test('boolean accepts truthy tokens', () => {
    for (const token of ['true', 'TRUE', 'yes', 'Yes', '1']) {
      expect(coerce(token, 'boolean')).toBe(true);
    }
  });

  test('boolean accepts falsy tokens', () => {
    for (const token of ['false', 'FALSE', 'no', 'No', '0']) {
      expect(coerce(token, 'boolean')).toBe(false);
    }
  });

  test('boolean rejects ambiguous tokens', () => {
    expect(() => coerce('maybe', 'boolean')).toThrow(InputError);
    expect(() => coerce('on', 'boolean')).toThrow(InputError);
  });
});

describe('resolveInputs', () => {
  const defs: Record<string, Input> = {
    environment: { type: 'string', required: true },
    'dry-run': { type: 'boolean', default: false },
    replicas: { type: 'number', default: 1 },
  };

  test('applies provided values with coercion', () => {
    const out = resolveInputs({
      taskName: 'deploy',
      defs,
      provided: { environment: 'staging', 'dry-run': 'yes', replicas: '3' },
    });
    expect(out).toEqual({ environment: 'staging', 'dry-run': true, replicas: 3 });
  });

  test('applies defaults for omitted optionals', () => {
    const out = resolveInputs({
      taskName: 'deploy',
      defs,
      provided: { environment: 'prod' },
    });
    expect(out).toEqual({ environment: 'prod', 'dry-run': false, replicas: 1 });
  });

  test('errors on missing required input', () => {
    expect(() => resolveInputs({ taskName: 'deploy', defs, provided: {} })).toThrow(
      /missing required input 'environment'/,
    );
  });

  test('warns on unknown provided inputs and passes them through as strings', () => {
    const warnings: string[] = [];
    const out = resolveInputs({
      taskName: 'deploy',
      defs,
      provided: { environment: 'prod', surprise: 'value' },
      onWarning: (msg) => warnings.push(msg),
    });
    expect(out.surprise).toBe('value');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`unknown input 'surprise'`);
  });

  test('coercion errors are attributed to the input name and task', () => {
    expect(() =>
      resolveInputs({
        taskName: 'deploy',
        defs,
        provided: { environment: 'staging', replicas: 'three' },
      }),
    ).toThrow(/input 'replicas' for task 'deploy': expected a number/);
  });

  test('tasks without inputs definitions warn on every --with key', () => {
    const warnings: string[] = [];
    const out = resolveInputs({
      taskName: 'build',
      provided: { x: '1', y: '2' },
      onWarning: (msg) => warnings.push(msg),
    });
    expect(out).toEqual({ x: '1', y: '2' });
    expect(warnings).toHaveLength(2);
  });

  test('optional inputs without defaults are simply absent', () => {
    const out = resolveInputs({
      taskName: 't',
      defs: { tag: { type: 'string' } },
      provided: {},
    });
    expect(out).toEqual({});
  });
});
