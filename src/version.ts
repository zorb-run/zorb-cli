import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

// Injected by the bundler at build time (see A16). Empty in dev mode.
declare const __ZORB_BUILD_HASH__: string | undefined;
const BUILD_HASH: string = typeof __ZORB_BUILD_HASH__ === 'string' ? __ZORB_BUILD_HASH__ : '';

let cached: string | undefined;

function readGitHash(): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dir,
      stderr: 'ignore',
    });
    if (result.exitCode === 0) {
      return new TextDecoder().decode(result.stdout).trim();
    }
  } catch {
    // Fall through.
  }
  return '';
}

export function getGitHash(): string {
  if (cached !== undefined) return cached;
  cached = BUILD_HASH || readGitHash();
  return cached;
}

export function getVersionString(): string {
  const hash = getGitHash();
  return hash ? `${VERSION} (${hash})` : VERSION;
}
