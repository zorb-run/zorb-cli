import { describe, expect, test } from 'bun:test';
import {
  ExpressionError,
  interpolate,
  interpolateMap,
  interpolateValue,
  interpolateWith,
} from '../src/expressions.ts';

const ctx = (inputs: Record<string, string | number | boolean>) => ({ inputs });

describe('interpolate', () => {
  test('substitutes a single inputs.<name>', () => {
    expect(interpolate('${{ inputs.env }}', ctx({ env: 'prod' }))).toBe('prod');
  });

  test('substitutes multiple expressions in one string', () => {
    expect(
      interpolate('${{ inputs.a }}-${{ inputs.b }}', ctx({ a: 'x', b: 'y' })),
    ).toBe('x-y');
  });

  test('tolerates missing whitespace', () => {
    expect(interpolate('${{inputs.env}}', ctx({ env: 'prod' }))).toBe('prod');
  });

  test('keeps the surrounding string', () => {
    expect(interpolate('host-${{ inputs.env }}.local', ctx({ env: 'staging' }))).toBe(
      'host-staging.local',
    );
  });

  test('supports hyphenated input names', () => {
    expect(interpolate('${{ inputs.dry-run }}', ctx({ 'dry-run': true }))).toBe('true');
  });

  test('stringifies non-string values', () => {
    expect(interpolate('${{ inputs.n }}', ctx({ n: 3 }))).toBe('3');
    expect(interpolate('${{ inputs.b }}', ctx({ b: false }))).toBe('false');
  });

  test('returns the input unchanged when no expressions are present', () => {
    expect(interpolate('plain text', ctx({}))).toBe('plain text');
  });

  test('errors on undefined inputs', () => {
    try {
      interpolate('${{ inputs.missing }}', ctx({}));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionError);
      expect((e as ExpressionError).message).toContain('undefined input: missing');
    }
  });

  test('rejects complex expressions with a pointer to A5', () => {
    try {
      interpolate(`\${{ inputs.x == 'prod' ? 'a' : 'b' }}`, ctx({ x: 'prod' }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionError);
      expect((e as ExpressionError).message).toContain('unsupported expression at A3');
      expect((e as ExpressionError).message).toContain('A5');
    }
  });

  test('rejects env. / steps. / secrets. references at A3', () => {
    expect(() => interpolate('${{ env.FOO }}', ctx({}))).toThrow(ExpressionError);
    expect(() => interpolate('${{ steps.x.outputs.y }}', ctx({}))).toThrow(ExpressionError);
    expect(() => interpolate('${{ secrets.X }}', ctx({}))).toThrow(ExpressionError);
  });
});

describe('interpolateValue', () => {
  test('passes numbers and booleans through unchanged', () => {
    expect(interpolateValue(42, ctx({}))).toBe(42);
    expect(interpolateValue(true, ctx({}))).toBe(true);
  });

  test('interpolates strings', () => {
    expect(interpolateValue('${{ inputs.env }}', ctx({ env: 'prod' }))).toBe('prod');
  });
});

describe('interpolateMap / interpolateWith', () => {
  test('interpolateMap rewrites every value', () => {
    const out = interpolateMap(
      { A: '${{ inputs.env }}', B: 'static' },
      ctx({ env: 'prod' }),
    );
    expect(out).toEqual({ A: 'prod', B: 'static' });
  });

  test('interpolateWith preserves non-string values', () => {
    const out = interpolateWith(
      { tag: '${{ inputs.env }}', count: 3, dry: false },
      ctx({ env: 'staging' }),
    );
    expect(out).toEqual({ tag: 'staging', count: 3, dry: false });
  });
});
