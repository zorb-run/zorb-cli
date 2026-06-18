import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve as resolvePath } from 'node:path';

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
    if (uses.startsWith('@')) {
      throw new ResolveError(`cannot resolve NPM package action '${uses}'`, `NPM action resolution arrives in A9`);
    }
    throw new ResolveError(
      `cannot resolve '${uses}' — only local paths (./ or ../) are supported`,
      `NPM action resolution arrives in A9`,
    );
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
