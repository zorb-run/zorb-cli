import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface ParseEnvFileOptions {
  cwd?: string;
}

export class EnvFileError extends Error {
  override readonly name = 'EnvFileError';
  constructor(
    message: string,
    public readonly file: string,
    public readonly line?: number,
  ) {
    super(message);
  }
}

export function parseEnvFile(path: string, opts: ParseEnvFileOptions = {}): Record<string, string> {
  const resolved = isAbsolute(path) ? path : resolve(opts.cwd ?? process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new EnvFileError(`env file not found: ${path}`, resolved);
  }
  const text = readFileSync(resolved, 'utf-8');
  return parseEnvText(text, resolved);
}

/**
 * Parses a `-e/--env` argument. Accepts `KEY=VALUE` and `KEY` (key-only),
 * where the latter signals pass-through from the current process env — the
 * caller resolves the value from `process.env[key]`.
 */
export function parseInlineEnv(pair: string): [key: string, value: string | undefined] {
  const eq = pair.indexOf('=');

  if (eq === -1) {
    const key = pair.trim();
    if (key === '') {
      throw new EnvFileError(`invalid env value (expected KEY or KEY=VALUE): ${pair}`, '<argv>');
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new EnvFileError(`invalid env var name '${key}'`, '<argv>');
    }
    return [key, undefined];
  }

  if (eq < 1) {
    throw new EnvFileError(`invalid env value (expected KEY or KEY=VALUE): ${pair}`, '<argv>');
  }
  const key = pair.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new EnvFileError(`invalid env var name '${key}'`, '<argv>');
  }
  return [key, pair.slice(eq + 1)];
}

export function parseEnvText(text: string, file = '<inline>'): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const stripped = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eq = stripped.indexOf('=');
    if (eq < 1) {
      throw new EnvFileError(`invalid line in env file (expected KEY=VALUE): ${raw}`, file, lineNo);
    }
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new EnvFileError(`invalid env var name '${key}'`, file, lineNo);
    }

    const rest = stripped.slice(eq + 1);
    out[key] = unquoteValue(rest);
  }

  return out;
}

function unquoteValue(value: string): string {
  let v = value;
  // Strip an inline comment from unquoted values
  if (!v.startsWith('"') && !v.startsWith("'")) {
    const hash = v.indexOf(' #');
    if (hash !== -1) v = v.slice(0, hash);
    return v.trim();
  }
  const quote = v[0]!;
  if (v.length < 2 || v[v.length - 1] !== quote) return v;
  const inner = v.slice(1, -1);
  if (quote === '"') {
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return inner;
}

export interface ApplyOptions {
  override?: boolean;
}

export function applyEnv(
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  { override = false }: ApplyOptions = {},
): void {
  for (const [k, v] of Object.entries(vars)) {
    if (override || env[k] === undefined) env[k] = v;
  }
}
