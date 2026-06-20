#!/usr/bin/env bun
// Build the `zorb` package's compiled binaries.
//
// Each build produces dist/<platform>/zorb plus a shared dist/runners/ directory.
// The `zorb` package ships these under dist/, and bin/zorb.cjs (the user-installed
// command) execs the one matching the host platform at runtime.
//
// Usage:
//   bun scripts/build.ts                 # build all four platforms
//   bun scripts/build.ts --current       # build only the host platform
//   bun scripts/build.ts --target=...    # build a specific platform
//   bun scripts/build.ts --out=dist      # output dir (default dist/)

import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import minimist from 'minimist';

export type Platform = 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64';

export const PLATFORMS: Record<Platform, { bunTarget: Bun.Build.CompileTarget }> = {
  'darwin-x64': { bunTarget: 'bun-darwin-x64' },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64' },
  'linux-x64': { bunTarget: 'bun-linux-x64' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64' },
};

export function currentPlatform(): Platform {
  const p = platform();
  const a = arch();

  if (p !== 'darwin' && p !== 'linux') {
    throw new Error(`unsupported host platform: ${p}/${a}`);
  }
  if (a !== 'arm64' && a !== 'x64') {
    throw new Error(`unsupported host platform: ${p}/${a}`);
  }

  const key = `${p}-${a}` as Platform;
  if (!(key in PLATFORMS)) {
    throw new Error(`unsupported host platform: ${p}/${a}`);
  }
  return key;
}

function readGitHash(repoRoot: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return '';
  return new TextDecoder().decode(result.stdout).trim();
}

interface BuildOptions {
  repoRoot: string;
  outDir: string;
  targets: Platform[];
  gitHash: string;
}

export async function build(opts: BuildOptions): Promise<void> {
  const entry = join(opts.repoRoot, 'src', 'cli.ts');
  const runnersSrc = join(opts.repoRoot, 'runners');
  const runnersDst = join(opts.outDir, 'runners');

  // Runners are identical across platforms (plain JS + Python). Ship one copy
  // at dist/runners/; each binary resolves it via dirname(execPath)/../runners.
  mkdirSync(opts.outDir, { recursive: true });
  rmSync(runnersDst, { recursive: true, force: true });
  cpSync(runnersSrc, runnersDst, { recursive: true });

  for (const target of opts.targets) {
    const spec = PLATFORMS[target];
    const dir = join(opts.outDir, target);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const outfile = join(dir, 'zorb');
    process.stderr.write(`> building ${target} → ${outfile}\n`);

    const result = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      compile: { target: spec.bunTarget, outfile },
      define: { __ZORB_BUILD_HASH__: JSON.stringify(opts.gitHash) },
    });
    if (!result.success) {
      for (const log of result.logs) process.stderr.write(`${log}\n`);
      throw new Error(`bun build failed for ${target}`);
    }

    // Bun's compile leaves a `.<hash>-<n>.bun-build` staging file next to the
    // process's cwd. Sweep them so they don't show up as untracked files.
    for (const entry of readdirSync(opts.repoRoot)) {
      if (/^\..+\.bun-build$/.test(entry)) {
        rmSync(join(opts.repoRoot, entry), { force: true });
      }
    }
  }
}

interface CliArgs {
  current?: boolean;
  target?: string | string[];
}

function parseTargets(argv: CliArgs): Platform[] {
  if (argv.current) return [currentPlatform()];
  if (argv.target) {
    const raw = Array.isArray(argv.target) ? argv.target : [argv.target];
    const out: Platform[] = [];
    for (const t of raw) {
      if (!(t in PLATFORMS)) {
        throw new Error(`unknown target: ${t} (valid: ${Object.keys(PLATFORMS).join(', ')})`);
      }
      out.push(t as Platform);
    }
    return out;
  }
  return Object.keys(PLATFORMS) as Platform[];
}

if (import.meta.main) {
  const argv = minimist(process.argv.slice(2), {
    boolean: ['current'],
    string: ['target', 'out'],
    default: { out: 'dist' },
  });
  const repoRoot = resolvePath(import.meta.dir, '..');
  const outDir = resolvePath(repoRoot, argv.out as string);
  const targets = parseTargets({
    current: Boolean(argv.current),
    target: argv.target as string | string[] | undefined,
  });
  const gitHash = readGitHash(repoRoot);

  await build({ repoRoot, outDir, targets, gitHash });
  process.stderr.write(`> built ${targets.length} target(s) → ${outDir}\n`);
}
