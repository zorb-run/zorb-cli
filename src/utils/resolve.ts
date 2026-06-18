import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, parse, resolve as resolvePath } from 'node:path';

export class ResolveError extends Error {
  override readonly name = 'ResolveError';
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
  }
}

export type ActionLanguage = 'js' | 'py';

export interface ResolvedAction {
  path: string;
  language: ActionLanguage;
}

export const ACTION_EXTENSIONS: readonly string[] = ['.js', '.cjs', '.mjs', '.ts', '.py'];

export interface ResolveOptions {
  uses: string;
  fromFile: string;
}

export function resolveAction({ uses, fromFile }: ResolveOptions): ResolvedAction {
  if (uses === '') {
    throw new ResolveError(`'uses:' value is empty`);
  }

  const isLocal = uses.startsWith('./') || uses.startsWith('../') || isAbsolute(uses);
  if (!isLocal) {
    return resolveNpmAction(uses, fromFile);
  }

  // Cross-file workflow refs use a 'zorb' basename: ./zorb.build,
  // ./infra/zorb.deploy. The segment before the first dot is 'zorb'.
  const base = parse(uses).base;
  const firstDot = base.indexOf('.');
  const stem = firstDot === -1 ? base : base.slice(0, firstDot);
  if (stem === 'zorb') {
    throw new ResolveError(`cannot resolve workflow task reference '${uses}'`, `cross-file references arrive in A10`);
  }

  const baseDir = dirname(fromFile);
  const absolute = isAbsolute(uses) ? uses : resolvePath(baseDir, uses);

  // If the user already wrote a recognised extension, use the file as-is.
  const exactExt = extensionOf(absolute);
  if (exactExt && ACTION_EXTENSIONS.includes(exactExt)) {
    if (existsAsFile(absolute)) {
      return { path: absolute, language: languageFor(exactExt) };
    }
    throw new ResolveError(`action file does not exist: ${absolute}`);
  }

  // Otherwise try each known extension in order.
  const tried: string[] = [];
  for (const ext of ACTION_EXTENSIONS) {
    const candidate = absolute + ext;
    tried.push(candidate);
    if (existsAsFile(candidate)) {
      return { path: candidate, language: languageFor(ext) };
    }
  }

  throw new ResolveError(`could not resolve action '${uses}'`, `tried: ${tried.join(', ')}`);
}

interface NpmSpec {
  pkg: string;
  subpath: string | undefined;
}

// Split `@scope/pkg/sub/path` → { pkg: '@scope/pkg', subpath: 'sub/path' }
// and `pkg/sub/path` → { pkg: 'pkg', subpath: 'sub/path' }.
function parseNpmSpec(uses: string): NpmSpec {
  if (uses.startsWith('@')) {
    const firstSlash = uses.indexOf('/');
    if (firstSlash < 0) {
      throw new ResolveError(`invalid NPM spec '${uses}' — scoped names need a package after the scope`);
    }
    const secondSlash = uses.indexOf('/', firstSlash + 1);
    if (secondSlash < 0) return { pkg: uses, subpath: undefined };
    return { pkg: uses.slice(0, secondSlash), subpath: uses.slice(secondSlash + 1) };
  }
  const firstSlash = uses.indexOf('/');
  if (firstSlash < 0) return { pkg: uses, subpath: undefined };
  return { pkg: uses.slice(0, firstSlash), subpath: uses.slice(firstSlash + 1) };
}

// We fast-fail on a missing package so we can emit a clean install hint;
// past that, Node's createRequire handles the real resolution (exports,
// conditions, wildcards) and we just inspect the returned file.
function resolveNpmAction(uses: string, fromFile: string): ResolvedAction {
  const spec = parseNpmSpec(uses);
  const anchor = dirname(fromFile);
  if (!findPackageDir(spec.pkg, anchor)) throw missingPackageError(spec.pkg);

  // createRequire just needs a path to anchor — the file doesn't need to exist.
  const userRequire = createRequire(join(anchor, 'noop.js'));
  let resolved: string;
  try {
    resolved = userRequire.resolve(uses);
  } catch (err) {
    throw new ResolveError(`could not resolve '${uses}': ${(err as Error).message}`);
  }
  const ext = extensionOf(resolved);
  const language = ext && ACTION_EXTENSIONS.includes(ext) ? languageFor(ext) : 'js';
  return { path: resolved, language };
}

function findPackageDir(pkg: string, fromDir: string): string | undefined {
  let dir = fromDir;
  while (true) {
    const candidate = join(dir, 'node_modules', pkg);
    if (existsAsFile(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function missingPackageError(pkg: string): ResolveError {
  const hint = pkg.startsWith('@zorb/')
    ? `Run: npm install ${pkg.split('/').slice(0, 2).join('/')}`
    : `did you install it in node_modules?`;
  return new ResolveError(`could not resolve action package '${pkg}' — not found in node_modules`, hint);
}

function languageFor(ext: string): ActionLanguage {
  return ext === '.py' ? 'py' : 'js';
}

function existsAsFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function extensionOf(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dot = p.lastIndexOf('.');
  if (dot < 0 || dot < slash) return '';
  return p.slice(dot);
}
