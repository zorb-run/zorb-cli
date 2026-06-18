import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAction, ResolveError, type ResolvedAction } from '../src/utils/resolve.ts';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-resolve-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function asFile(r: ResolvedAction): { path: string; language: 'js' | 'py' } {
  if (r.kind !== 'file') throw new Error(`expected file resolution, got ${r.kind}`);
  return { path: r.path, language: r.language };
}

function asPackage(r: ResolvedAction): { spec: string; anchor: string } {
  if (r.kind !== 'package') throw new Error(`expected package resolution, got ${r.kind}`);
  return { spec: r.spec, anchor: r.anchor };
}

describe('resolveAction — local paths', () => {
  test('resolves a path with an explicit recognised extension', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'foo.js'), 'module.exports = {};');
      const r = asFile(resolveAction({ uses: './foo.js', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'foo.js'));
      expect(r.language).toBe('js');
    } finally {
      cleanup();
    }
  });

  test('treats .py as Python', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'foo.py'), 'def action(i, c): return {}');
      const r = asFile(resolveAction({ uses: './foo.py', fromFile: join(dir, 'zorb.yml') }));
      expect(r.language).toBe('py');
    } finally {
      cleanup();
    }
  });

  test('extensionless paths try .js, .cjs, .mjs, .ts, .py in order', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'thing.ts'), 'export const action = () => ({});');
      const r = asFile(resolveAction({ uses: './thing', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'thing.ts'));
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
      const r = asFile(resolveAction({ uses: './scripts/tag.action', fromFile: join(dir, 'zorb.yml') }));
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
      const r = asFile(resolveAction({ uses: './thing', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'thing.js'));
    } finally {
      cleanup();
    }
  });

  test('absolute paths are resolved verbatim', () => {
    const { dir, cleanup } = tmp();
    try {
      const abs = join(dir, 'abs.js');
      writeFileSync(abs, '');
      const r = asFile(resolveAction({ uses: abs, fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(abs);
    } finally {
      cleanup();
    }
  });

  test('parent traversal works (../)', () => {
    const { dir, cleanup } = tmp();
    try {
      const sub = join(dir, 'sub');
      mkdirSync(sub);
      writeFileSync(join(dir, 'outer.js'), '');
      const r = asFile(resolveAction({ uses: '../outer.js', fromFile: join(sub, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'outer.js'));
    } finally {
      cleanup();
    }
  });
});

describe('resolveAction — npm packages', () => {
  // resolve.ts only verifies the package exists; the runner uses Node's
  // createRequire to handle the actual exports/conditions/wildcards lookup.
  function stubPackage(root: string, name: string): void {
    const pkgDir = join(root, 'node_modules', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name }));
  }

  test('scoped spec returns kind=package with spec + anchor', () => {
    const { dir, cleanup } = tmp();
    try {
      stubPackage(dir, '@zorb/aws');
      const r = asPackage(resolveAction({ uses: '@zorb/aws/s3/sync', fromFile: join(dir, 'zorb.yml') }));
      expect(r.spec).toBe('@zorb/aws/s3/sync');
      expect(r.anchor).toBe(dir);
    } finally {
      cleanup();
    }
  });

  test('unscoped spec returns kind=package with spec + anchor', () => {
    const { dir, cleanup } = tmp();
    try {
      stubPackage(dir, 'my-actions');
      const r = asPackage(resolveAction({ uses: 'my-actions/check', fromFile: join(dir, 'zorb.yml') }));
      expect(r.spec).toBe('my-actions/check');
      expect(r.anchor).toBe(dir);
    } finally {
      cleanup();
    }
  });

  test('walks up parent directories to find node_modules', () => {
    const { dir, cleanup } = tmp();
    try {
      stubPackage(dir, '@zorb/aws');
      const sub = join(dir, 'sub', 'deeper');
      mkdirSync(sub, { recursive: true });
      const r = asPackage(resolveAction({ uses: '@zorb/aws/check', fromFile: join(sub, 'zorb.yml') }));
      expect(r.spec).toBe('@zorb/aws/check');
      expect(r.anchor).toBe(sub);
    } finally {
      cleanup();
    }
  });

  test('missing @zorb/* package errors with an install hint', () => {
    const { dir, cleanup } = tmp();
    try {
      try {
        resolveAction({ uses: '@zorb/aws/s3/sync', fromFile: join(dir, 'zorb.yml') });
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
        resolveAction({ uses: 'some-pkg/action', fromFile: join(dir, 'zorb.yml') });
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

describe('resolveAction — errors', () => {
  test('rejects cross-file ./zorb.<task> with an A10 hint', () => {
    try {
      resolveAction({ uses: './zorb.build', fromFile: '/tmp/zorb.yml' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).hint).toContain('A10');
    }
  });

  test('rejects cross-file ./other/zorb.<task> with an A10 hint', () => {
    try {
      resolveAction({ uses: './infra/zorb.deploy', fromFile: '/tmp/zorb.yml' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).hint).toContain('A10');
    }
  });

  test('does NOT treat names that merely start with `zorb` as cross-file', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'zorb-helper.js'), '');
      const r = asFile(resolveAction({ uses: './zorb-helper.js', fromFile: join(dir, 'zorb.yml') }));
      expect(r.path).toBe(join(dir, 'zorb-helper.js'));
    } finally {
      cleanup();
    }
  });

  test('errors with a tried list when no extension matches', () => {
    const { dir, cleanup } = tmp();
    try {
      try {
        resolveAction({ uses: './missing', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        const err = e as ResolveError;
        expect(err.message).toContain(`could not resolve action './missing'`);
        expect(err.hint).toContain('.js');
        expect(err.hint).toContain('.py');
      }
    } finally {
      cleanup();
    }
  });

  test('errors when the explicit-extension file does not exist', () => {
    const { dir, cleanup } = tmp();
    try {
      try {
        resolveAction({ uses: './nope.js', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        expect((e as ResolveError).message).toContain('action file does not exist');
      }
    } finally {
      cleanup();
    }
  });
});
