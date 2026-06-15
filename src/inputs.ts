import type { Input, InputType, WithValue } from './types.ts';

export class InputError extends Error {
  override readonly name = 'InputError';
  constructor(message: string) {
    super(message);
  }
}

export function parseWithPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) {
      throw new InputError(`invalid --with value (expected key=value): ${pair}`);
    }
    const key = pair.slice(0, eq).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) {
      throw new InputError(`invalid input name '${key}'`);
    }
    out[key] = pair.slice(eq + 1);
  }
  return out;
}

const TRUE_TOKENS = new Set(['true', 'yes', '1']);
const FALSE_TOKENS = new Set(['false', 'no', '0']);

export function coerce(raw: string, type: InputType = 'string'): WithValue {
  switch (type) {
    case 'string':
      return raw;
    case 'number': {
      const trimmed = raw.trim();
      if (trimmed === '') throw new InputError(`expected a number, got an empty string`);
      const n = Number(trimmed);
      if (!Number.isFinite(n)) throw new InputError(`expected a number, got '${raw}'`);
      return n;
    }
    case 'boolean': {
      const token = raw.trim().toLowerCase();
      if (TRUE_TOKENS.has(token)) return true;
      if (FALSE_TOKENS.has(token)) return false;
      throw new InputError(`expected a boolean (true/false/yes/no/1/0), got '${raw}'`);
    }
  }
}

export interface ResolveOptions {
  taskName: string;
  defs?: Record<string, Input>;
  provided: Record<string, string>;
  onWarning?: (message: string) => void;
}

export function resolveInputs({
  taskName,
  defs = {},
  provided,
  onWarning,
}: ResolveOptions): Record<string, WithValue> {
  const out: Record<string, WithValue> = Object.create(null);

  for (const name of Object.keys(defs)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
      throw new InputError(`invalid input name '${name}' in inputs definition for task '${taskName}'`);
    }
  }

  for (const [name, raw] of Object.entries(provided)) {
    const def = defs[name];
    if (!def) {
      onWarning?.(`unknown input '${name}' for task '${taskName}' (no inputs definition)`);
      out[name] = raw;
      continue;
    }
    try {
      out[name] = coerce(raw, def.type);
    } catch (e) {
      if (e instanceof InputError) {
        throw new InputError(`input '${name}' for task '${taskName}': ${e.message}`);
      }
      throw e;
    }
  }

  for (const [name, def] of Object.entries(defs)) {
    if (name in out) continue;
    if (def.default !== undefined) {
      try {
        if (def.type && def.type !== 'string' && typeof def.default === 'string') {
          out[name] = coerce(def.default, def.type);
        } else if (def.type && def.type !== 'string' && typeof def.default !== def.type) {
          throw new InputError(`default must be a ${def.type}`);
        } else {
          out[name] = def.default;
        }
      } catch (e) {
        if (e instanceof InputError) {
          throw new InputError(`input '${name}' for task '${taskName}': ${e.message}`);
        }
        throw e;
      }
      continue;
    }
    if (def.required) {
      throw new InputError(`missing required input '${name}' for task '${taskName}'`);
    }
  }

  return out;
}
