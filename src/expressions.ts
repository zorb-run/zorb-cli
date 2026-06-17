import type { WithValue } from './types.ts';

export class ExpressionError extends Error {
  override readonly name = 'ExpressionError';
  constructor(message: string) {
    super(message);
  }
}

export interface InterpolationContext {
  inputs: Record<string, WithValue>;
  env: Record<string, string>;
  secrets?: Record<string, string>;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

type TT =
  | 'STR' | 'NUM' | 'BOOL' | 'IDENT'
  | 'DOT' | 'PIPE'
  | 'EQEQ' | 'NEQ' | 'AND' | 'OR' | 'BANG'
  | 'QMARK' | 'COLON'
  | 'LP' | 'RP' | 'COMMA'
  | 'EOF';

interface Tok {
  t: TT;
  v: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) break;

    const pos = i;
    const c = src[i]!;

    // String literal (single or double quoted)
    if (c === '"' || c === "'") {
      const q = c;
      let s = '';
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < src.length) { i++; s += src[i++]; }
        else s += src[i++];
      }
      if (src[i] !== q) throw new ExpressionError(`unterminated string at position ${pos}`);
      i++;
      toks.push({ t: 'STR', v: s, pos });
      continue;
    }

    // Number literal (non-negative integers and decimals)
    if (/[0-9]/.test(c)) {
      let s = '';
      while (i < src.length && /[0-9]/.test(src[i]!)) s += src[i++];
      if (src[i] === '.') {
        s += src[i++];
        while (i < src.length && /[0-9]/.test(src[i]!)) s += src[i++];
      }
      toks.push({ t: 'NUM', v: s, pos });
      continue;
    }

    // Two-character operators (checked before single-char to avoid partial matches)
    const two = src.slice(i, i + 2);
    if (two === '==') { toks.push({ t: 'EQEQ', v: '==', pos }); i += 2; continue; }
    if (two === '!=') { toks.push({ t: 'NEQ', v: '!=', pos }); i += 2; continue; }
    if (two === '&&') { toks.push({ t: 'AND', v: '&&', pos }); i += 2; continue; }
    if (two === '||') { toks.push({ t: 'OR', v: '||', pos }); i += 2; continue; }

    // Single-character tokens
    if (c === '!') { toks.push({ t: 'BANG', v: '!', pos }); i++; continue; }
    if (c === '|') { toks.push({ t: 'PIPE', v: '|', pos }); i++; continue; }
    if (c === '.') { toks.push({ t: 'DOT', v: '.', pos }); i++; continue; }
    if (c === '?') { toks.push({ t: 'QMARK', v: '?', pos }); i++; continue; }
    if (c === ':') { toks.push({ t: 'COLON', v: ':', pos }); i++; continue; }
    if (c === '(') { toks.push({ t: 'LP', v: '(', pos }); i++; continue; }
    if (c === ')') { toks.push({ t: 'RP', v: ')', pos }); i++; continue; }
    if (c === ',') { toks.push({ t: 'COMMA', v: ',', pos }); i++; continue; }

    // Identifiers — hyphens are allowed mid-word so input names like dry-run work.
    // A hyphen is only consumed if the character after it is alphanumeric (no trailing
    // hyphens, no ambiguity with operators).
    if (/[a-zA-Z_]/.test(c)) {
      let s = c;
      i++;
      while (i < src.length) {
        const ch = src[i]!;
        if (/[a-zA-Z0-9_]/.test(ch)) { s += ch; i++; }
        else if (ch === '-' && /[a-zA-Z0-9_]/.test(src[i + 1] ?? '')) {
          s += src[i++]; // hyphen
          s += src[i++]; // the char after it
        }
        else break;
      }
      toks.push({ t: s === 'true' || s === 'false' ? 'BOOL' : 'IDENT', v: s, pos });
      continue;
    }

    throw new ExpressionError(`unexpected character '${c}' at position ${pos} in expression`);
  }

  toks.push({ t: 'EOF', v: '', pos: src.length });
  return toks;
}

// ─── AST ─────────────────────────────────────────────────────────────────────

type ExprNode =
  | { k: 'str'; value: string }
  | { k: 'num'; value: number }
  | { k: 'bool'; value: boolean }
  | { k: 'var'; path: string[] }
  | { k: 'call'; name: string; args: ExprNode[] }
  | { k: 'not'; expr: ExprNode }
  | { k: 'eq' | 'neq'; left: ExprNode; right: ExprNode }
  | { k: 'and' | 'or'; left: ExprNode; right: ExprNode }
  | { k: 'ternary'; cond: ExprNode; yes: ExprNode; no: ExprNode };

// ─── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.i]!; }
  private consume(): Tok { return this.toks[this.i++]!; }

  private expect(t: TT): Tok {
    const tok = this.consume();
    if (tok.t !== t) throw new ExpressionError(`expected '${t}', got '${tok.v}' at position ${tok.pos}`);
    return tok;
  }

  private match(t: TT): boolean {
    if (this.peek().t === t) { this.i++; return true; }
    return false;
  }

  parse(): ExprNode {
    const node = this.parseTernary();
    const rem = this.peek();
    if (rem.t !== 'EOF') throw new ExpressionError(`unexpected '${rem.v}' at position ${rem.pos}`);
    return node;
  }

  private parseTernary(): ExprNode {
    const cond = this.parseOr();
    if (!this.match('QMARK')) return cond;
    const yes = this.parseTernary(); // right-associative: a ? b : c ? d : e → a ? b : (c ? d : e)
    this.expect('COLON');
    const no = this.parseTernary();
    return { k: 'ternary', cond, yes, no };
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.peek().t === 'OR') {
      this.consume();
      const right = this.parseAnd();
      left = { k: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseNot();
    while (this.peek().t === 'AND') {
      this.consume();
      const right = this.parseNot();
      left = { k: 'and', left, right };
    }
    return left;
  }

  private parseNot(): ExprNode {
    if (this.match('BANG')) return { k: 'not', expr: this.parseNot() };
    return this.parseComparison();
  }

  private parseComparison(): ExprNode {
    const left = this.parsePipeline();
    const t = this.peek().t;
    if (t === 'EQEQ' || t === 'NEQ') {
      this.consume();
      const right = this.parsePipeline();
      return { k: t === 'EQEQ' ? 'eq' : 'neq', left, right };
    }
    return left;
  }

  // Pipe-filter syntax: `a | fn` desugars to `fn(a)`, `a | fn(x)` to `fn(a, x)`.
  // Filters compose left-to-right.
  private parsePipeline(): ExprNode {
    let node = this.parsePrimary();
    while (this.peek().t === 'PIPE') {
      this.consume();
      const nameTok = this.expect('IDENT');
      let extra: ExprNode[] = [];
      if (this.match('LP')) {
        if (this.peek().t !== 'RP') extra = this.parseArgList();
        this.expect('RP');
      }
      node = { k: 'call', name: nameTok.v, args: [node, ...extra] };
    }
    return node;
  }

  private parsePrimary(): ExprNode {
    const tok = this.peek();

    if (tok.t === 'LP') {
      this.consume();
      const node = this.parseTernary();
      this.expect('RP');
      return node;
    }

    if (tok.t === 'STR') { this.consume(); return { k: 'str', value: tok.v }; }
    if (tok.t === 'NUM') { this.consume(); return { k: 'num', value: Number(tok.v) }; }
    if (tok.t === 'BOOL') { this.consume(); return { k: 'bool', value: tok.v === 'true' }; }

    if (tok.t === 'IDENT') {
      this.consume();
      const name = tok.v;

      // Function call: name(args...)
      if (this.match('LP')) {
        const args = this.peek().t !== 'RP' ? this.parseArgList() : [];
        this.expect('RP');
        return { k: 'call', name, args };
      }

      // Variable path: ns.key(.subkey)*
      if (this.peek().t === 'DOT') {
        const path = [name];
        while (this.peek().t === 'DOT') {
          this.consume();
          const part = this.consume();
          if (part.t !== 'IDENT' && part.t !== 'BOOL') {
            throw new ExpressionError(`expected identifier after '.', got '${part.v}' at position ${part.pos}`);
          }
          path.push(part.v);
        }
        return { k: 'var', path };
      }

      throw new ExpressionError(
        `unexpected identifier '${name}' at position ${tok.pos} — did you mean inputs.${name}, env.${name}, or secrets.${name}?`,
      );
    }

    throw new ExpressionError(`unexpected '${tok.v}' at position ${tok.pos}`);
  }

  private parseArgList(): ExprNode[] {
    const args: ExprNode[] = [this.parseTernary()];
    while (this.match('COMMA')) args.push(this.parseTernary());
    return args;
  }
}

// ─── Built-in filter registry ─────────────────────────────────────────────────

type ExprValue = string | number | boolean;
type FilterFn = (args: (ExprValue | undefined)[]) => ExprValue;

function requireStr(v: ExprValue | undefined, fn: string): string {
  if (typeof v !== 'string') throw new ExpressionError(`${fn}() first argument must be a string`);
  return v;
}

function requireArg(v: ExprValue | undefined, fn: string, n: number): ExprValue {
  if (v === undefined) throw new ExpressionError(`${fn}() requires at least ${n} argument(s)`);
  return v;
}

const FILTERS = new Map<string, FilterFn>([
  ['upper',      ([v])       => requireStr(v, 'upper').toUpperCase()],
  ['lower',      ([v])       => requireStr(v, 'lower').toLowerCase()],
  ['trim',       ([v])       => requireStr(v, 'trim').trim()],
  ['length',     ([v])       => { requireArg(v, 'length', 1); return String(v).length; }],
  ['string',     ([v])       => { requireArg(v, 'string', 1); return String(v); }],
  ['number',     ([v])       => {
    requireArg(v, 'number', 1);
    const n = Number(v);
    if (isNaN(n)) throw new ExpressionError(`number(): cannot convert '${v}' to a number`);
    return n;
  }],
  ['boolean',    ([v])       => {
    requireArg(v, 'boolean', 1);
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    throw new ExpressionError(`boolean(): cannot convert '${v}' to a boolean`);
  }],
  ['default',    ([v, d])    => {
    requireArg(d, 'default', 2);
    return v !== undefined && v !== '' ? v : d!;
  }],
  ['replace',    ([v, f, t]) => {
    const s = requireStr(v, 'replace');
    requireArg(f, 'replace', 2); requireArg(t, 'replace', 3);
    return s.split(String(f)).join(String(t));
  }],
  ['contains',   ([v, n])    => {
    const s = requireStr(v, 'contains');
    requireArg(n, 'contains', 2);
    return s.includes(String(n));
  }],
  ['startsWith', ([v, p])    => {
    const s = requireStr(v, 'startsWith');
    requireArg(p, 'startsWith', 2);
    return s.startsWith(String(p));
  }],
  ['endsWith',   ([v, p])    => {
    const s = requireStr(v, 'endsWith');
    requireArg(p, 'endsWith', 2);
    return s.endsWith(String(p));
  }],
]);

// ─── Evaluator ───────────────────────────────────────────────────────────────

function evaluate(node: ExprNode, ctx: InterpolationContext): ExprValue {
  switch (node.k) {
    case 'str':  return node.value;
    case 'num':  return node.value;
    case 'bool': return node.value;

    case 'var': {
      const [ns, ...parts] = node.path;
      const key = parts.join('.');
      if (ns === 'inputs') {
        if (!Object.hasOwn(ctx.inputs, key)) throw new ExpressionError(`undefined variable: inputs.${key}`);
        return ctx.inputs[key] as ExprValue;
      }
      if (ns === 'env') {
        if (!Object.hasOwn(ctx.env, key)) throw new ExpressionError(`undefined variable: env.${key}`);
        return ctx.env[key]!;
      }
      if (ns === 'secrets') {
        if (!ctx.secrets || !Object.hasOwn(ctx.secrets, key)) {
          throw new ExpressionError(`undefined secret: secrets.${key}`);
        }
        return ctx.secrets[key]!;
      }
      if (ns === 'steps') {
        throw new ExpressionError(`step output expressions are not yet supported — coming in A12`);
      }
      throw new ExpressionError(`unknown variable namespace '${ns}' — supported: inputs, env, secrets`);
    }

    case 'call': {
      // default(v, fallback) evaluates the fallback lazily so that
      // `default(inputs.x, inputs.missing)` doesn't throw when inputs.x is set.
      if (node.name === 'default') {
        if (node.args.length !== 2) throw new ExpressionError('default() requires exactly 2 arguments');
        const v = evaluate(node.args[0]!, ctx);
        return (v !== undefined && v !== '') ? v : evaluate(node.args[1]!, ctx);
      }
      const fn = FILTERS.get(node.name);
      if (!fn) {
        const known = [...FILTERS.keys()].join(', ');
        throw new ExpressionError(`unknown function '${node.name}' — known: ${known}`);
      }
      return fn(node.args.map((a) => evaluate(a, ctx)));
    }

    case 'not': return !evaluate(node.expr, ctx);

    case 'and': {
      const left = evaluate(node.left, ctx);
      return left ? evaluate(node.right, ctx) : left;
    }

    case 'or': {
      const left = evaluate(node.left, ctx);
      return left ? left : evaluate(node.right, ctx);
    }

    case 'eq':  return String(evaluate(node.left, ctx)) === String(evaluate(node.right, ctx));
    case 'neq': return String(evaluate(node.left, ctx)) !== String(evaluate(node.right, ctx));

    case 'ternary': {
      const cond = evaluate(node.cond, ctx);
      return evaluate(cond ? node.yes : node.no, ctx);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Scan text for ${{ ... }} blocks. The regex approach (`/\$\{\{([\s\S]*?)\}\}/g`)
// would terminate at the first `}}` even inside a string literal (e.g. `${{ '}}' }}`),
// so we use a manual scanner that skips quoted strings and their escape sequences.
function scanExpressions(text: string): Array<{ start: number; end: number; body: string }> {
  const results: Array<{ start: number; end: number; body: string }> = [];
  let i = 0;

  while (i < text.length) {
    const si = text.indexOf('${{', i);
    if (si === -1) break;

    let j = si + 3;
    let found = false;

    while (j < text.length) {
      const c = text[j]!;

      if (c === '"' || c === "'") {
        const q = c;
        j++;
        while (j < text.length && text[j] !== q) {
          if (text[j] === '\\' && j + 1 < text.length) j++; // skip escape
          j++;
        }
        j++; // skip closing quote
      } else if (c === '}' && text[j + 1] === '}') {
        results.push({ start: si, end: j + 2, body: text.slice(si + 3, j).trim() });
        i = j + 2;
        found = true;
        break;
      } else {
        j++;
      }
    }

    if (!found) i = si + 3; // no closing }} found — treat ${{ as literal text
  }

  return results;
}

function evalBody(body: string, ctx: InterpolationContext): string {
  const toks = tokenize(body);
  const ast = new Parser(toks).parse();
  return String(evaluate(ast, ctx));
}

export function interpolate(text: string, ctx: InterpolationContext): string {
  if (!text.includes('${{')) return text;
  const exprs = scanExpressions(text);
  if (exprs.length === 0) return text;
  let result = '';
  let pos = 0;
  for (const expr of exprs) {
    result += text.slice(pos, expr.start);
    result += evalBody(expr.body, ctx);
    pos = expr.end;
  }
  return result + text.slice(pos);
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
  for (const [k, v] of Object.entries(map)) out[k] = interpolate(v, ctx);
  return out;
}

export function interpolateWith(
  map: Record<string, WithValue>,
  ctx: InterpolationContext,
): Record<string, WithValue> {
  const out: Record<string, WithValue> = Object.create(null);
  for (const [k, v] of Object.entries(map)) out[k] = interpolateValue(v, ctx);
  return out;
}
