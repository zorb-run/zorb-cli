import { existsSync, statSync } from 'node:fs';
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

/**
 * Either a concrete file (local action) or an NPM spec the runner will
 * resolve via Node's own algorithm. NPM specs are always JS — Python packages
 * aren't in scope; `.py` actions are always local files.
 */
export type ResolvedAction =
  | { kind: 'file'; path: string; language: ActionLanguage }
  | { kind: 'package'; spec: string; anchor: string };

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
      return { kind: 'file', path: absolute, language: languageFor(exactExt) };
    }
    throw new ResolveError(`action file does not exist: ${absolute}`);
  }

  // Otherwise try each known extension in order.
  const tried: string[] = [];
  for (const ext of ACTION_EXTENSIONS) {
    const candidate = absolute + ext;
    tried.push(candidate);
    if (existsAsFile(candidate)) {
      return { kind: 'file', path: candidate, language: languageFor(ext) };
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

// We do a fast existence check on the package's node_modules entry so we can
// emit a clean `npm install @zorb/aws` hint before spawning the runner.
// Beyond that, the runner uses Node's createRequire to resolve the actual
// file — that gives us exports, conditions, and wildcards for free.
function resolveNpmAction(uses: string, fromFile: string): ResolvedAction {
  const spec = parseNpmSpec(uses);
  const anchor = dirname(fromFile);
  const pkgDir = findPackageDir(spec.pkg, anchor);
  if (!pkgDir) throw missingPackageError(spec.pkg);
  return { kind: 'package', spec: uses, anchor };
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
