import { existsSync, readFileSync, statSync } from 'node:fs';
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

// Conditions we honour inside `exports` maps, in priority order. Zorb actions
// are executed via runner.cjs (`require`) or runner.py, so `require` and
// `default` are the meaningful ones; `import` and `node` are accepted because
// well-behaved packages still ship them.
const EXPORTS_CONDITIONS: readonly string[] = ['default', 'require', 'node', 'import'];

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

function resolveNpmAction(uses: string, fromFile: string): ResolvedAction {
  const spec = parseNpmSpec(uses);
  const pkgDir = findPackageDir(spec.pkg, dirname(fromFile));
  if (!pkgDir) throw missingPackageError(spec.pkg);

  const pkgJsonPath = join(pkgDir, 'package.json');
  const pkgJson = readPackageJson(pkgJsonPath);

  const target = spec.subpath
    ? resolveSubpath(pkgDir, pkgJson, spec.subpath, uses)
    : resolvePackageEntry(pkgDir, pkgJson, uses);

  return target;
}

interface PackageJson {
  main?: string;
  exports?: unknown;
}

function readPackageJson(path: string): PackageJson {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new ResolveError(`could not read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as PackageJson;
  } catch (err) {
    throw new ResolveError(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

function resolveSubpath(pkgDir: string, pkgJson: PackageJson, subpath: string, uses: string): ResolvedAction {
  const exportsField = pkgJson.exports;
  if (exportsField && typeof exportsField === 'object') {
    const key = `./${subpath}`;
    const mapped = pickExport((exportsField as Record<string, unknown>)[key]);
    if (mapped !== undefined) {
      return loadFromPackage(pkgDir, mapped, uses);
    }
    // If the package declares exports but doesn't include this subpath,
    // surface that clearly — modern packages with exports use it as a
    // gate, so probing past it would mask typos.
    if (hasAnyExportKey(exportsField)) {
      throw new ResolveError(`'${uses}' is not exported by '${pkgJsonName(pkgDir)}'`, `expected an exports key '${key}'`);
    }
  }

  // No exports field — treat subpath as a relative file inside the package.
  const absolute = join(pkgDir, subpath);
  const exactExt = extensionOf(absolute);
  if (exactExt && ACTION_EXTENSIONS.includes(exactExt)) {
    if (existsAsFile(absolute)) return { path: absolute, language: languageFor(exactExt) };
    throw new ResolveError(`action file does not exist: ${absolute}`);
  }
  const tried: string[] = [];
  for (const ext of ACTION_EXTENSIONS) {
    const candidate = absolute + ext;
    tried.push(candidate);
    if (existsAsFile(candidate)) return { path: candidate, language: languageFor(ext) };
  }
  throw new ResolveError(`could not resolve action '${uses}'`, `tried: ${tried.join(', ')}`);
}

function resolvePackageEntry(pkgDir: string, pkgJson: PackageJson, uses: string): ResolvedAction {
  const exportsField = pkgJson.exports;
  if (exportsField !== undefined) {
    const mapped =
      typeof exportsField === 'string'
        ? exportsField
        : typeof exportsField === 'object'
          ? pickExport((exportsField as Record<string, unknown>)['.'])
          : undefined;
    if (mapped !== undefined) return loadFromPackage(pkgDir, mapped, uses);
  }
  if (pkgJson.main) return loadFromPackage(pkgDir, pkgJson.main, uses);
  for (const ext of ACTION_EXTENSIONS) {
    const candidate = join(pkgDir, `index${ext}`);
    if (existsAsFile(candidate)) return { path: candidate, language: languageFor(ext) };
  }
  throw new ResolveError(`could not resolve package entry for '${uses}'`, `no 'exports', 'main', or 'index.*' found`);
}

// Walks `exports` values: strings → use directly; objects → first matching
// condition by EXPORTS_CONDITIONS order. Arrays (fallback chains) aren't
// supported yet — action packages don't need them.
function pickExport(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const cond of EXPORTS_CONDITIONS) {
    const next = obj[cond];
    if (next !== undefined) {
      const picked = pickExport(next);
      if (picked !== undefined) return picked;
    }
  }
  return undefined;
}

function hasAnyExportKey(exportsField: unknown): boolean {
  if (typeof exportsField !== 'object' || exportsField === null) return false;
  return Object.keys(exportsField as Record<string, unknown>).some((k) => k.startsWith('./') || k === '.');
}

function loadFromPackage(pkgDir: string, relative: string, uses: string): ResolvedAction {
  const cleaned = relative.startsWith('./') ? relative.slice(2) : relative;
  const absolute = join(pkgDir, cleaned);
  if (!existsAsFile(absolute)) {
    throw new ResolveError(`'${uses}' resolved to a missing file: ${absolute}`);
  }
  const ext = extensionOf(absolute);
  const lang = ext && ACTION_EXTENSIONS.includes(ext) ? languageFor(ext) : 'js';
  return { path: absolute, language: lang };
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

function pkgJsonName(pkgDir: string): string {
  try {
    const json = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
    return (json && typeof json.name === 'string' ? json.name : pkgDir) as string;
  } catch {
    return pkgDir;
  }
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
