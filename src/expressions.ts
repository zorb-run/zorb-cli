import type { WithValue } from './types.ts';

export class ExpressionError extends Error {
  override readonly name = 'ExpressionError';
  constructor(message: string) {
    super(message);
  }
}

export interface InterpolationContext {
  inputs: Record<string, WithValue>;
}

// A3 only supports the bare `${{ inputs.<name> }}` form. The full engine
// (operators, ternaries, function calls, filters, secrets, step outputs)
// arrives in A5.
const EXPRESSION = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
const SIMPLE_INPUT = /^inputs\.([a-zA-Z_][a-zA-Z0-9_-]*)$/;

export function interpolate(text: string, ctx: InterpolationContext): string {
  return text.replace(EXPRESSION, (_match, body: string) => {
    const m = SIMPLE_INPUT.exec(body);
    if (!m) {
      throw new ExpressionError(
        `unsupported expression at A3: '${body}' — only \`inputs.<name>\` is supported; the full engine arrives in A5`,
      );
    }
    const key = m[1]!;
    if (!(key in ctx.inputs)) {
      throw new ExpressionError(`undefined input: ${key}`);
    }
    return String(ctx.inputs[key]);
  });
}

export function interpolateValue(value: WithValue, ctx: InterpolationContext): WithValue {
  if (typeof value !== 'string') return value;
  return interpolate(value, ctx);
}

export function interpolateMap(
  map: Record<string, string>,
  ctx: InterpolationContext,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(map)) {
    out[k] = interpolate(v, ctx);
  }
  return out;
}

export function interpolateWith(
  map: Record<string, WithValue>,
  ctx: InterpolationContext,
): Record<string, WithValue> {
  const out: Record<string, WithValue> = Object.create(null);
  for (const [k, v] of Object.entries(map)) {
    out[k] = interpolateValue(v, ctx);
  }
  return out;
}
