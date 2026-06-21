import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUses, ResolveError, type Resolved, type ResolvedAction } from '../src/utils/resolve.ts';

function asAction(r: Resolved): ResolvedAction {
  if (r.kind !== 'action') throw new Error(`expected action, got ${r.kind}`);
  return r;
}

// Bun on macOS hands out /var/folders/... but Node's createRequire returns
// /private/var/folders/... (realpath). Normalise once so the two agree.
function tmp(): { dir: string; cleanup: () => void } {
  const raw = mkdtempSync(join(tmpdir(), 'zorb-resolve-'));
  const dir = realpathSync(raw);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('resolveUses — local paths', () => {
  test('detects a .py file as Python', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'foo.py'), 'def action(i, c): return {}');
      const r = asAction(resolveUses({ uses: './foo', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'foo.py'));
      expect(r.language).toBe('py');
    } finally {
      cleanup();
    }
  });

  test('appends a runtime extension to an extensionless path', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'thing.cjs'), 'module.exports.action = () => ({});');
      const r = asAction(resolveUses({ uses: './thing', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'thing.cjs'));
      expect(r.language).toBe('js');
    } finally {
      cleanup();
    }
  });

  test('the .action convention resolves via appended runtime extension', () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts', 'tag.action.cjs'), 'module.exports.action = () => ({});');
      const r = asAction(resolveUses({ uses: './scripts/tag.action', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'scripts', 'tag.action.cjs'));
    } finally {
      cleanup();
    }
  });

  test('prefers earlier extensions in the order list when several exist', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'thing.js'), '');
      writeFileSync(join(dir, 'thing.ts'), '');
      const r = asAction(resolveUses({ uses: './thing', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'thing.ts'));
    } finally {
      cleanup();
    }
  });

  test('warns when multiple extensions match the same extensionless path', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'thing.ts'), '');
      writeFileSync(join(dir, 'thing.js'), '');
      writeFileSync(join(dir, 'thing.py'), '');
      const warnings: string[] = [];
      const r = asAction(
        resolveUses({ uses: './thing', fromFile: join(dir, 'zorb.yml'), onWarning: (m) => warnings.push(m) }),
      );
      expect(r.path).toBe(join(dir, 'thing.ts'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`multiple files match './thing'`);
      expect(warnings[0]).toContain(join(dir, 'thing.ts'));
      expect(warnings[0]).toContain(join(dir, 'thing.js'));
      expect(warnings[0]).toContain(join(dir, 'thing.py'));
    } finally {
      cleanup();
    }
  });

  test('does not warn when only one extension matches', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'only.ts'), '');
      const warnings: string[] = [];
      const r = asAction(
        resolveUses({ uses: './only', fromFile: join(dir, 'zorb.yml'), onWarning: (m) => warnings.push(m) }),
      );
      expect(r.path).toBe(join(dir, 'only.ts'));
      expect(warnings).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('absolute paths resolve via the same extension detection', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'abs.ts'), '');
      const r = asAction(resolveUses({ uses: join(dir, 'abs'), fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'abs.ts'));
    } finally {
      cleanup();
    }
  });

  test('parent traversal works (../)', () => {
    const { dir, cleanup } = tmp();
    try {
      const sub = join(dir, 'sub');
      mkdirSync(sub);
      writeFileSync(join(dir, 'outer.ts'), '');
      const r = asAction(resolveUses({ uses: '../outer', fromFile: join(sub, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'outer.ts'));
    } finally {
      cleanup();
    }
  });
});

describe('resolveUses — npm packages', () => {
  function writePackage(
    root: string,
    name: string,
    pkgJson: Record<string, unknown>,
    files: Record<string, string>,
  ): string {
    const pkgDir = join(root, 'node_modules', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, ...pkgJson }));
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(pkgDir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
    }
    return pkgDir;
  }

  test('resolves a scoped package via exports field', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(
        dir,
        '@zorb/aws',
        { exports: { './s3/sync': './dist/s3/sync.js' } },
        { 'dist/s3/sync.js': 'module.exports.action = () => ({});' },
      );
      const r = asAction(resolveUses({ uses: '@zorb/aws/s3/sync', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'node_modules', '@zorb/aws', 'dist', 's3', 'sync.js'));
      expect(r.language).toBe('js');
    } finally {
      cleanup();
    }
  });

  test('walks up parent directories to find node_modules', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, '@zorb/aws', { exports: { './check': './check.js' } }, { 'check.js': '' });
      const sub = join(dir, 'sub', 'deeper');
      mkdirSync(sub, { recursive: true });
      const r = asAction(resolveUses({ uses: '@zorb/aws/check', fromFile: join(sub, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'node_modules', '@zorb/aws', 'check.js'));
    } finally {
      cleanup();
    }
  });

  test('language is derived from the resolved file extension', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, 'py-pkg', { exports: { './check': './check.py' } }, { 'check.py': '' });
      const r = asAction(resolveUses({ uses: 'py-pkg/check', fromFile: join(dir, 'zorb.yml') }));
      expect(r.language).toBe('py');
    } finally {
      cleanup();
    }
  });

  test('missing @zorb/* package errors with an install hint', () => {
    const { dir, cleanup } = tmp();
    try {
      try {
        resolveUses({ uses: '@zorb/aws/s3/sync', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        const err = e as ResolveError;
        expect(err.message).toContain('@zorb/aws');
        expect(err.message).toContain('node_modules');
        expect(err.hint).toBe('Run: npm install @zorb/aws');
      }
    } finally {
      cleanup();
    }
  });

  test('missing non-@zorb package errors with a generic hint', () => {
    const { dir, cleanup } = tmp();
    try {
      try {
        resolveUses({ uses: 'some-pkg/action', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        const err = e as ResolveError;
        expect(err.message).toContain('some-pkg');
        expect(err.hint).not.toContain('@zorb');
      }
    } finally {
      cleanup();
    }
  });
});

describe('resolveUses — cross-file workflow refs', () => {
  test('./zorb.<task> resolves to a workflow ref in the same directory', () => {
    const r = resolveUses({ uses: './zorb.build', fromFile: '/tmp/zorb.yml' });
    expect(r.kind).toBe('workflow');
    if (r.kind !== 'workflow') throw new Error('expected workflow');
    expect(r.workflowPath).toBe('/tmp/zorb.yml');
    expect(r.taskName).toBe('build');
  });

  test('./dir/zorb.<task> resolves to a workflow ref in a sibling directory', () => {
    const r = resolveUses({ uses: './infra/zorb.deploy', fromFile: '/tmp/zorb.yml' });
    expect(r.kind).toBe('workflow');
    if (r.kind !== 'workflow') throw new Error('expected workflow');
    expect(r.workflowPath).toBe('/tmp/infra/zorb.yml');
    expect(r.taskName).toBe('deploy');
  });

  test('../zorb.<task> resolves a parent-directory workflow ref', () => {
    const r = resolveUses({ uses: '../zorb.build', fromFile: '/tmp/sub/zorb.yml' });
    expect(r.kind).toBe('workflow');
    if (r.kind !== 'workflow') throw new Error('expected workflow');
    expect(r.workflowPath).toBe('/tmp/zorb.yml');
    expect(r.taskName).toBe('build');
  });

  test('absolute path zorb.<task> resolves verbatim', () => {
    const r = resolveUses({ uses: '/abs/dir/zorb.run-it', fromFile: '/tmp/zorb.yml' });
    expect(r.kind).toBe('workflow');
    if (r.kind !== 'workflow') throw new Error('expected workflow');
    expect(r.workflowPath).toBe('/abs/dir/zorb.yml');
    expect(r.taskName).toBe('run-it');
  });

  test('./zorb (no task name) errors', () => {
    try {
      resolveUses({ uses: './zorb', fromFile: '/tmp/zorb.yml' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).message).toContain('no task name');
    }
  });

  test('./zorb. (empty task name) errors', () => {
    try {
      resolveUses({ uses: './zorb.', fromFile: '/tmp/zorb.yml' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).message).toContain('no task name');
    }
  });

  test('./zorb.foo.bar (extra dot in task name) errors', () => {
    try {
      resolveUses({ uses: './zorb.foo.bar', fromFile: '/tmp/zorb.yml' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).message).toContain('invalid task name');
    }
  });
});

describe('resolveUses — errors', () => {
  test('does NOT treat names that merely start with `zorb` as cross-file', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb-helper.ts'), '');
      const r = asAction(resolveUses({ uses: './zorb-helper', fromFile: join(dir, 'zorb.yml') }));
      expect(r.kind).toBe('action');
      if (r.kind !== 'action') throw new Error('expected action');
      expect(r.path).toBe(join(dir, 'zorb-helper.ts'));
    } finally {
      cleanup();
    }
  });

  test('errors with a tried list when no extension matches', () => {
    const { dir, cleanup } = tmp();
    try {
      try {
        resolveUses({ uses: './missing', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        const err = e as ResolveError;
        expect(err.message).toContain(`could not resolve action './missing'`);
        expect(err.hint).toContain('.ts');
        expect(err.hint).toContain('.py');
      }
    } finally {
      cleanup();
    }
  });

  test('rejects explicit runtime extensions with a drop-the-extension hint', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'foo.ts'), '');
      try {
        resolveUses({ uses: './foo.ts', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        const err = e as ResolveError;
        expect(err.message).toContain(`'uses:' value './foo.ts' includes a runtime extension`);
        expect(err.hint).toContain(`drop the '.ts' suffix`);
      }
    } finally {
      cleanup();
    }
  });

  test('rejects explicit runtime extensions even when the file does not exist', () => {
    const { dir, cleanup } = tmp();
    try {
      try {
        resolveUses({ uses: './nope.js', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        expect((e as ResolveError).message).toContain('includes a runtime extension');
      }
    } finally {
      cleanup();
    }
  });
});
