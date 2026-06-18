import { describe, expect, test } from 'bun:test';
import { ExpressionError, interpolate, interpolateMap, interpolateValue, interpolateWith } from '../src/expressions.ts';
import type { InterpolationContext } from '../src/expressions.ts';

const ctx = (
  inputs: Record<string, string | number | boolean> = {},
  env: Record<string, string> = {},
  secrets: Record<string, string> = {},
): InterpolationContext => ({ inputs, env, secrets });

// ─── Basic variable resolution ───────────────────────────────────────────────

describe('inputs variables', () => {
  test('substitutes a single inputs.<name>', () => {
    expect(interpolate('${{ inputs.env }}', ctx({ env: 'prod' }))).toBe('prod');
  });

  test('substitutes multiple expressions in one string', () => {
    expect(interpolate('${{ inputs.a }}-${{ inputs.b }}', ctx({ a: 'x', b: 'y' }))).toBe('x-y');
  });

  test('tolerates missing whitespace', () => {
    expect(interpolate('${{inputs.env}}', ctx({ env: 'prod' }))).toBe('prod');
  });

  test('keeps the surrounding string', () => {
    expect(interpolate('host-${{ inputs.env }}.local', ctx({ env: 'staging' }))).toBe('host-staging.local');
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
    expect(() => interpolate('${{ inputs.missing }}', ctx({}))).toThrow(ExpressionError);
    expect(() => interpolate('${{ inputs.missing }}', ctx({}))).toThrow('undefined variable: inputs.missing');
  });

  test('prototype property names are not valid variables', () => {
    expect(() => interpolate('${{ inputs.toString }}', ctx({}))).toThrow(ExpressionError);
    expect(() => interpolate('${{ inputs.constructor }}', ctx({}))).toThrow(ExpressionError);
  });
});

describe('env variables', () => {
  test('substitutes env.<name>', () => {
    expect(interpolate('${{ env.FOO }}', ctx({}, { FOO: 'bar' }))).toBe('bar');
  });

  test('errors on undefined env var', () => {
    expect(() => interpolate('${{ env.MISSING }}', ctx({}, {}))).toThrow(ExpressionError);
    expect(() => interpolate('${{ env.MISSING }}', ctx({}, {}))).toThrow('undefined variable: env.MISSING');
  });
});

// ─── Operators ───────────────────────────────────────────────────────────────

describe('equality operators', () => {
  test('== true when equal', () => {
    expect(interpolate(`\${{ inputs.env == 'prod' }}`, ctx({ env: 'prod' }))).toBe('true');
  });

  test('== false when not equal', () => {
    expect(interpolate(`\${{ inputs.env == 'prod' }}`, ctx({ env: 'staging' }))).toBe('false');
  });

  test('!= true when not equal', () => {
    expect(interpolate(`\${{ inputs.env != 'prod' }}`, ctx({ env: 'staging' }))).toBe('true');
  });

  test('== compares stringified values (boolean vs string)', () => {
    expect(interpolate(`\${{ inputs.flag == 'true' }}`, ctx({ flag: true }))).toBe('true');
  });

  test('== compares numbers as strings', () => {
    expect(interpolate(`\${{ inputs.n == 3 }}`, ctx({ n: 3 }))).toBe('true');
  });
});

describe('logical operators', () => {
  test('&& returns right operand when left is truthy', () => {
    expect(interpolate(`\${{ inputs.a && inputs.b }}`, ctx({ a: 'x', b: 'y' }))).toBe('y');
  });

  test('&& short-circuits on falsy left', () => {
    expect(interpolate(`\${{ inputs.a && inputs.b }}`, ctx({ a: false, b: 'y' }))).toBe('false');
  });

  test('|| returns left when truthy', () => {
    expect(interpolate(`\${{ inputs.a || inputs.b }}`, ctx({ a: 'x', b: 'y' }))).toBe('x');
  });

  test('|| returns right when left is falsy', () => {
    expect(interpolate(`\${{ inputs.a || inputs.b }}`, ctx({ a: '', b: 'fallback' }))).toBe('fallback');
  });

  test('! negates a boolean input', () => {
    expect(interpolate(`\${{ !inputs.dry-run }}`, ctx({ 'dry-run': false }))).toBe('true');
    expect(interpolate(`\${{ !inputs.dry-run }}`, ctx({ 'dry-run': true }))).toBe('false');
  });

  test('!! double-negation', () => {
    expect(interpolate(`\${{ !!inputs.x }}`, ctx({ x: 'yes' }))).toBe('true');
    expect(interpolate(`\${{ !!inputs.x }}`, ctx({ x: '' }))).toBe('false');
  });
});

// ─── Ternary ─────────────────────────────────────────────────────────────────

describe('ternary', () => {
  test('returns yes branch when condition is true', () => {
    expect(interpolate(`\${{ inputs.env == 'prod' ? 'production' : 'staging' }}`, ctx({ env: 'prod' }))).toBe(
      'production',
    );
  });

  test('returns no branch when condition is false', () => {
    expect(interpolate(`\${{ inputs.env == 'prod' ? 'production' : 'staging' }}`, ctx({ env: 'dev' }))).toBe('staging');
  });

  test('ternary with boolean input', () => {
    expect(interpolate(`\${{ inputs.dry-run ? 'skip' : 'deploy' }}`, ctx({ 'dry-run': true }))).toBe('skip');
    expect(interpolate(`\${{ inputs.dry-run ? 'skip' : 'deploy' }}`, ctx({ 'dry-run': false }))).toBe('deploy');
  });

  test('nested ternary is right-associative', () => {
    // a ? b : c ? d : e  →  a ? b : (c ? d : e)
    expect(
      interpolate(`\${{ inputs.x == 'a' ? 'first' : inputs.x == 'b' ? 'second' : 'other' }}`, ctx({ x: 'a' })),
    ).toBe('first');
    expect(
      interpolate(`\${{ inputs.x == 'a' ? 'first' : inputs.x == 'b' ? 'second' : 'other' }}`, ctx({ x: 'b' })),
    ).toBe('second');
    expect(
      interpolate(`\${{ inputs.x == 'a' ? 'first' : inputs.x == 'b' ? 'second' : 'other' }}`, ctx({ x: 'c' })),
    ).toBe('other');
  });
});

// ─── Built-in functions / filters ────────────────────────────────────────────

describe('functions', () => {
  test('upper', () => expect(interpolate('${{ upper(inputs.x) }}', ctx({ x: 'hello' }))).toBe('HELLO'));
  test('lower', () => expect(interpolate('${{ lower(inputs.x) }}', ctx({ x: 'HELLO' }))).toBe('hello'));
  test('trim', () => expect(interpolate('${{ trim(inputs.x) }}', ctx({ x: '  hi  ' }))).toBe('hi'));
  test('length', () => expect(interpolate('${{ length(inputs.x) }}', ctx({ x: 'abc' }))).toBe('3'));
  test('string', () => expect(interpolate('${{ string(inputs.n) }}', ctx({ n: 42 }))).toBe('42'));
  test('number', () => expect(interpolate('${{ number(inputs.s) }}', ctx({ s: '7' }))).toBe('7'));
  test('boolean true values', () => {
    for (const v of ['true', '1', 'yes']) {
      expect(interpolate('${{ boolean(inputs.v) }}', ctx({ v }))).toBe('true');
    }
  });
  test('boolean false values', () => {
    for (const v of ['false', '0', 'no']) {
      expect(interpolate('${{ boolean(inputs.v) }}', ctx({ v }))).toBe('false');
    }
  });
  test('default — value present', () => {
    expect(interpolate(`\${{ default(inputs.x, 'fallback') }}`, ctx({ x: 'actual' }))).toBe('actual');
  });
  test('default — value absent/empty', () => {
    expect(interpolate(`\${{ default(inputs.x, 'fallback') }}`, ctx({ x: '' }))).toBe('fallback');
  });
  test('default — fallback is lazy (not evaluated when value is present)', () => {
    // inputs.missing is not defined, but should not throw because inputs.x is set
    expect(interpolate(`\${{ default(inputs.x, inputs.missing) }}`, ctx({ x: 'actual' }))).toBe('actual');
  });
  test('replace', () => {
    expect(interpolate(`\${{ replace(inputs.x, 'a', 'b') }}`, ctx({ x: 'banana' }))).toBe('bbnbnb');
  });
  test('contains true', () => {
    expect(interpolate(`\${{ contains(inputs.x, 'ell') }}`, ctx({ x: 'hello' }))).toBe('true');
  });
  test('contains false', () => {
    expect(interpolate(`\${{ contains(inputs.x, 'xyz') }}`, ctx({ x: 'hello' }))).toBe('false');
  });
  test('startsWith', () => {
    expect(interpolate(`\${{ startsWith(inputs.x, 'he') }}`, ctx({ x: 'hello' }))).toBe('true');
  });
  test('endsWith', () => {
    expect(interpolate(`\${{ endsWith(inputs.x, 'lo') }}`, ctx({ x: 'hello' }))).toBe('true');
  });
});

// ─── Pipe-filter syntax ───────────────────────────────────────────────────────

describe('pipe filters', () => {
  test('single filter: x | trim', () => {
    expect(interpolate('${{ inputs.x | trim }}', ctx({ x: '  hi  ' }))).toBe('hi');
  });

  test('chained filters: x | trim | upper', () => {
    expect(interpolate('${{ inputs.x | trim | upper }}', ctx({ x: '  hello  ' }))).toBe('HELLO');
  });

  test('filter with args: x | replace(a, b)', () => {
    expect(interpolate(`\${{ inputs.x | replace('a', 'b') }}`, ctx({ x: 'banana' }))).toBe('bbnbnb');
  });

  test('filter chain with args', () => {
    expect(interpolate(`\${{ inputs.x | trim | replace('a', '_') }}`, ctx({ x: '  cat  ' }))).toBe('c_t');
  });
});

// ─── Error cases ─────────────────────────────────────────────────────────────

describe('scanner — }} inside string literals', () => {
  test('string literal containing }} does not terminate the expression early', () => {
    expect(interpolate(`\${{ replace(inputs.x, 'a', '}}') }}`, ctx({ x: 'abc' }))).toBe('}}bc');
  });

  test('${{ without closing }} is treated as literal text', () => {
    expect(interpolate('no closing ${{ here', ctx({}))).toBe('no closing ${{ here');
  });
});

describe('error cases', () => {
  test('unknown function', () => {
    expect(() => interpolate('${{ foo(inputs.x) }}', ctx({ x: 'v' }))).toThrow(ExpressionError);
    expect(() => interpolate('${{ foo(inputs.x) }}', ctx({ x: 'v' }))).toThrow("unknown function 'foo'");
  });

  test('bare identifier errors with hint', () => {
    expect(() => interpolate('${{ foo }}', ctx({}))).toThrow(ExpressionError);
  });

  test('unknown namespace errors', () => {
    expect(() => interpolate('${{ foo.bar }}', ctx({}))).toThrow(ExpressionError);
    expect(() => interpolate('${{ foo.bar }}', ctx({}))).toThrow(
      "unknown variable namespace 'foo' — supported: inputs, env, secrets, steps",
    );
  });

  test('secrets reference resolves from context', () => {
    expect(interpolate('${{ secrets.TOKEN }}', ctx({}, {}, { TOKEN: 'abc' }))).toBe('abc');
  });

  test('undefined secret reference errors', () => {
    expect(() => interpolate('${{ secrets.MISSING }}', ctx())).toThrow(ExpressionError);
    expect(() => interpolate('${{ secrets.MISSING }}', ctx())).toThrow('undefined secret: secrets.MISSING');
  });

  test('secrets not in context errors', () => {
    const noSecrets: InterpolationContext = { inputs: {}, env: {} };
    expect(() => interpolate('${{ secrets.X }}', noSecrets)).toThrow(ExpressionError);
    expect(() => interpolate('${{ secrets.X }}', noSecrets)).toThrow('undefined secret: secrets.X');
  });

  test('steps.<id>.outputs.<key> resolves a step output', () => {
    const c: InterpolationContext = {
      inputs: {},
      env: {},
      steps: { version: { outputs: { tag: 'v1.2.3' } } },
    };
    expect(interpolate('${{ steps.version.outputs.tag }}', c)).toBe('v1.2.3');
  });

  test('step output references stringify numbers and booleans', () => {
    const c: InterpolationContext = {
      inputs: {},
      env: {},
      steps: { s: { outputs: { n: 42, b: true } } },
    };
    expect(interpolate('${{ steps.s.outputs.n }}', c)).toBe('42');
    expect(interpolate('${{ steps.s.outputs.b }}', c)).toBe('true');
  });

  test('step output references JSON-encode objects and arrays', () => {
    const c: InterpolationContext = {
      inputs: {},
      env: {},
      steps: { s: { outputs: { obj: { a: 1 }, arr: [1, 2] } } },
    };
    expect(interpolate('${{ steps.s.outputs.obj }}', c)).toBe('{"a":1}');
    expect(interpolate('${{ steps.s.outputs.arr }}', c)).toBe('[1,2]');
  });

  test('undefined step reference errors', () => {
    expect(() => interpolate('${{ steps.missing.outputs.x }}', ctx({}))).toThrow(ExpressionError);
    expect(() => interpolate('${{ steps.missing.outputs.x }}', ctx({}))).toThrow('undefined step: steps.missing');
  });

  test('undefined step output errors', () => {
    const c: InterpolationContext = {
      inputs: {},
      env: {},
      steps: { s: { outputs: { a: '1' } } },
    };
    expect(() => interpolate('${{ steps.s.outputs.missing }}', c)).toThrow(ExpressionError);
    expect(() => interpolate('${{ steps.s.outputs.missing }}', c)).toThrow(
      'undefined step output: steps.s.outputs.missing',
    );
  });

  test('malformed steps reference errors', () => {
    const c: InterpolationContext = {
      inputs: {},
      env: {},
      steps: { s: { outputs: { a: '1' } } },
    };
    expect(() => interpolate('${{ steps.s.a }}', c)).toThrow(ExpressionError);
    expect(() => interpolate('${{ steps.s.a }}', c)).toThrow(
      "invalid step reference 'steps.s.a' — expected 'steps.<id>.outputs.<key>'",
    );
  });

  test('unterminated string — scanner treats unclosed ${{ as literal text', () => {
    // The string literal is never closed, so the scanner can't find a matching }}
    // and passes the ${{ through as literal text rather than erroring.
    expect(interpolate(`\${{ 'unclosed }}`, ctx({}))).toBe(`\${{ 'unclosed }}`);
  });
});

// ─── interpolateValue / interpolateMap / interpolateWith ─────────────────────

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
    const out = interpolateMap({ A: '${{ inputs.env }}', B: 'static' }, ctx({ env: 'prod' }));
    expect(out).toEqual({ A: 'prod', B: 'static' });
  });

  test('interpolateWith preserves non-string values', () => {
    const out = interpolateWith({ tag: '${{ inputs.env }}', count: 3, dry: false }, ctx({ env: 'staging' }));
    expect(out).toEqual({ tag: 'staging', count: 3, dry: false });
  });
});
