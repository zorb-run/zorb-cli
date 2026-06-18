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

describe('resolveAction — errors', () => {
  test('rejects NPM specs with an A9 hint', () => {
    expect(() => resolveAction({ uses: '@zorb/aws/s3/sync', fromFile: '/tmp/zorb.yml' })).toThrow(ResolveError);
    try {
      resolveAction({ uses: '@zorb/aws/s3/sync', fromFile: '/tmp/zorb.yml' });
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).hint).toContain('A9');
    }
  });

  test('rejects bare names (no leading ./) with an A9 hint', () => {
    try {
      resolveAction({ uses: 'some-lib/action', fromFile: '/tmp/zorb.yml' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResolveError);
      expect((e as ResolveError).hint).toContain('A9');
    }
  });

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
