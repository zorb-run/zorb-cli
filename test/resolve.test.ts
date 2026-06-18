import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAction, ResolveError } from '../src/utils/resolve.ts';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'zorb-resolve-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('resolveAction — local paths', () => {
  test('resolves a path with an explicit recognised extension', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'foo.js'), 'module.exports = {};');
      const r = resolveAction({ uses: './foo.js', fromFile: join(dir, 'zorb.yml') });
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
      const r = resolveAction({ uses: './foo.py', fromFile: join(dir, 'zorb.yml') });
      expect(r.language).toBe('py');
    } finally {
      cleanup();
    }
  });

  test('extensionless paths try .js, .cjs, .mjs, .ts, .py in order', () => {
    const { dir, cleanup } = tmp();
    try {
      writeFileSync(join(dir, 'thing.ts'), 'export const action = () => ({});');
      const r = resolveAction({ uses: './thing', fromFile: join(dir, 'zorb.yml') });
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
      const r = resolveAction({
        uses: './scripts/tag.action',
        fromFile: join(dir, 'zorb.yml'),
      });
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
      const r = resolveAction({ uses: './thing', fromFile: join(dir, 'zorb.yml') });
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
      const r = resolveAction({ uses: abs, fromFile: join(dir, 'zorb.yml') });
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
      const r = resolveAction({ uses: '../outer.js', fromFile: join(sub, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'outer.js'));
    } finally {
      cleanup();
    }
  });
});

describe('resolveAction — npm packages', () => {
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
      const r = resolveAction({ uses: '@zorb/aws/s3/sync', fromFile: join(dir, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'node_modules', '@zorb/aws', 'dist', 's3', 'sync.js'));
      expect(r.language).toBe('js');
    } finally {
      cleanup();
    }
  });

  test('resolves a scoped package via a conditional exports map', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(
        dir,
        '@zorb/aws',
        { exports: { './s3/sync': { import: './dist/s3/sync.mjs', require: './dist/s3/sync.cjs' } } },
        { 'dist/s3/sync.cjs': '', 'dist/s3/sync.mjs': '' },
      );
      const r = resolveAction({ uses: '@zorb/aws/s3/sync', fromFile: join(dir, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'node_modules', '@zorb/aws', 'dist', 's3', 'sync.cjs'));
    } finally {
      cleanup();
    }
  });

  test('resolves an unscoped package via exports field', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, 'my-actions', { exports: { './check': './check.js' } }, { 'check.js': '' });
      const r = resolveAction({ uses: 'my-actions/check', fromFile: join(dir, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'node_modules', 'my-actions', 'check.js'));
    } finally {
      cleanup();
    }
  });

  test('without exports field, resolves subpath as a file with extension probing', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, 'simple-pkg', {}, { 'actions/check.ts': '' });
      const r = resolveAction({ uses: 'simple-pkg/actions/check', fromFile: join(dir, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'node_modules', 'simple-pkg', 'actions', 'check.ts'));
    } finally {
      cleanup();
    }
  });

  test('without subpath, falls back to package.json main', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, 'entry-pkg', { main: 'lib/index.js' }, { 'lib/index.js': '' });
      const r = resolveAction({ uses: 'entry-pkg', fromFile: join(dir, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'node_modules', 'entry-pkg', 'lib', 'index.js'));
    } finally {
      cleanup();
    }
  });

  test('without subpath, falls back to index.* if no main', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, 'idx-pkg', {}, { 'index.cjs': '' });
      const r = resolveAction({ uses: 'idx-pkg', fromFile: join(dir, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'node_modules', 'idx-pkg', 'index.cjs'));
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
      const r = resolveAction({ uses: '@zorb/aws/check', fromFile: join(sub, 'zorb.yml') });
      expect(r.path).toBe(join(dir, 'node_modules', '@zorb/aws', 'check.js'));
    } finally {
      cleanup();
    }
  });

  test('resolves Python files via .py extension', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, 'py-pkg', { exports: { './check': './check.py' } }, { 'check.py': '' });
      const r = resolveAction({ uses: 'py-pkg/check', fromFile: join(dir, 'zorb.yml') });
      expect(r.language).toBe('py');
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

  test('exports-gated package errors clearly when subpath is missing', () => {
    const { dir, cleanup } = tmp();
    try {
      writePackage(dir, '@zorb/aws', { exports: { './s3/sync': './dist/s3/sync.js' } }, { 'dist/s3/sync.js': '' });
      try {
        resolveAction({ uses: '@zorb/aws/lambda/deploy', fromFile: join(dir, 'zorb.yml') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ResolveError);
        const err = e as ResolveError;
        expect(err.message).toContain('not exported');
        expect(err.hint).toContain('./lambda/deploy');
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
      const r = resolveAction({ uses: './zorb-helper.js', fromFile: join(dir, 'zorb.yml') });
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
