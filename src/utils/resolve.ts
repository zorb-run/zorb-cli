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
  kind: 'action';
  path: string;
  language: ActionLanguage;
}

export interface ResolvedWorkflow {
  kind: 'workflow';
  /** Absolute path to the callee's zorb.yml. */
  workflowPath: string;
  taskName: string;
}

export type Resolved = ResolvedAction | ResolvedWorkflow;

export const ACTION_EXTENSIONS: readonly string[] = ['.ts', '.mjs', '.cjs', '.js', '.py'];

export interface ResolveOptions {
  uses: string;
  fromFile: string;
  /** Called for non-fatal diagnostics (e.g. multiple extension matches). */
  onWarning?: (message: string) => void;
}

export function resolveUses({ uses, fromFile, onWarning }: ResolveOptions): Resolved {
  if (uses === '') {
    throw new ResolveError(`'uses:' value is empty`);
  }

  const isLocal = uses.startsWith('./') || uses.startsWith('../') || isAbsolute(uses);
  if (!isLocal) {
    return resolveNpmAction(uses, fromFile);
  }

  // Reject runtime extensions on the `uses:` value. Authors write the file's
  // logical name (`./scripts/greet.action`) and zorb picks the runtime from
  // disk — so renaming `greet.action.js` → `greet.action.ts` doesn't ripple
  // through every workflow that references it.
  const exactExt = extensionOf(uses);
  if (exactExt && ACTION_EXTENSIONS.includes(exactExt)) {
    throw new ResolveError(
      `'uses:' value '${uses}' includes a runtime extension`,
      `drop the '${exactExt}' suffix — zorb detects the runtime from the file on disk`,
    );
  }

  // Cross-file workflow refs use a 'zorb' basename: ./zorb.build,
  // ./infra/zorb.deploy. The segment before the first dot is 'zorb'.
  const base = parse(uses).base;
  const firstDot = base.indexOf('.');
  const stem = firstDot === -1 ? base : base.slice(0, firstDot);
  if (stem === 'zorb') {
    return resolveWorkflowRef(uses, fromFile, base, firstDot, onWarning);
  }

  const baseDir = dirname(fromFile);
  const absolute = resolvePath(baseDir, uses);

  // Try each known extension in order. Collect every match so we can warn when
  // more than one runtime would resolve the same `uses:` value — it's the kind
  // of ambiguity that bites later (e.g. a stale `.js` shadowing a freshly
  // authored `.ts`).
  const tried: string[] = [];
  const matches: { path: string; ext: string }[] = [];
  for (const ext of ACTION_EXTENSIONS) {
    const candidate = absolute + ext;
    tried.push(candidate);
    if (existsAsFile(candidate)) matches.push({ path: candidate, ext });
  }

  if (matches.length === 0) {
    throw new ResolveError(`could not resolve action '${uses}'`, `tried: ${tried.join(', ')}`);
  }

  const chosen = matches[0]!;
  if (matches.length > 1 && onWarning) {
    const others = matches
      .slice(1)
      .map((m) => m.path)
      .join(', ');
    onWarning(`multiple files match '${uses}' — using ${chosen.path} (also found: ${others})`);
  }
  return { kind: 'action', path: chosen.path, language: languageFor(chosen.ext) };
}

export const WORKFLOW_EXTENSIONS: readonly string[] = ['.yml', '.yaml'];

// Parse `./[dir/]zorb.<taskname>` into a workflow ref. We pick the workflow
// file on disk so cross-file calls don't have to guess at the callee's
// extension; both zorb.yml and zorb.yaml are accepted, .yml wins when both
// exist (with a warning), and the resolver falls back to zorb.yml when neither
// exists so the loader emits a clean not-found error.
function resolveWorkflowRef(
  uses: string,
  fromFile: string,
  base: string,
  firstDot: number,
  onWarning: ((message: string) => void) | undefined,
): ResolvedWorkflow {
  const taskName = firstDot === -1 ? '' : base.slice(firstDot + 1);
  if (taskName.length === 0) {
    throw new ResolveError(
      `workflow reference '${uses}' has no task name`,
      `expected the form ./[dir/]zorb.<taskname>`,
    );
  }
  if (taskName.includes('.')) {
    throw new ResolveError(
      `workflow reference '${uses}' has an invalid task name '${taskName}'`,
      `task names cannot contain '.'`,
    );
  }
  const baseDir = dirname(fromFile);
  const usesDir = dirname(uses);
  const targetDir = resolvePath(baseDir, usesDir);
  const workflowPath = pickWorkflowFile(targetDir, uses, onWarning);
  return { kind: 'workflow', workflowPath, taskName };
}

function pickWorkflowFile(
  dir: string,
  uses: string,
  onWarning: ((message: string) => void) | undefined,
): string {
  const matches: string[] = [];
  for (const ext of WORKFLOW_EXTENSIONS) {
    const candidate = join(dir, `zorb${ext}`);
    if (existsAsFile(candidate)) matches.push(candidate);
  }
  if (matches.length === 0) return join(dir, 'zorb.yml');
  const chosen = matches[0]!;
  if (matches.length > 1 && onWarning) {
    const others = matches.slice(1).join(', ');
    onWarning(`workflow reference '${uses}' matches multiple files — using ${chosen} (also found: ${others})`);
  }
  return chosen;
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
  return { kind: 'action', path: resolved, language };
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
