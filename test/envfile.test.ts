import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEnv, EnvFileError, parseEnvFile, parseEnvText } from '../src/envfile.ts';

describe('parseEnvText', () => {
  test('parses KEY=VALUE pairs', () => {
    expect(parseEnvText('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('ignores comments and blank lines', () => {
    const text = `# top\n\nFOO=bar\n\n# end\n`;
    expect(parseEnvText(text)).toEqual({ FOO: 'bar' });
  });

  test('handles export prefix', () => {
    expect(parseEnvText('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  test('strips inline comments on unquoted values', () => {
    expect(parseEnvText('FOO=bar # trailing')).toEqual({ FOO: 'bar' });
  });

  test('preserves whitespace inside double-quoted values', () => {
    expect(parseEnvText('FOO="a b c"')).toEqual({ FOO: 'a b c' });
  });

  test('expands escape sequences in double-quoted values', () => {
    expect(parseEnvText('FOO="line1\\nline2"')).toEqual({ FOO: 'line1\nline2' });
  });

  test('keeps single-quoted values literal', () => {
    expect(parseEnvText(`FOO='line1\\nline2'`)).toEqual({ FOO: 'line1\\nline2' });
  });

  test('rejects lines without an =', () => {
    try {
      parseEnvText('FOO\nBAR=x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvFileError);
      expect((e as EnvFileError).line).toBe(1);
    }
  });

  test('rejects invalid var names', () => {
    try {
      parseEnvText('1FOO=bar');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvFileError);
      expect((e as EnvFileError).message).toContain('invalid env var name');
    }
  });
});

describe('parseEnvFile', () => {
  test('reads from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zorb-env-'));
    try {
      const file = join(dir, '.env');
      writeFileSync(file, 'FOO=bar\nBAZ=qux');
      expect(parseEnvFile(file)).toEqual({ FOO: 'bar', BAZ: 'qux' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws EnvFileError when missing', () => {
    try {
      parseEnvFile('/this/does/not/exist.env');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvFileError);
    }
  });
});

describe('applyEnv', () => {
  test('does not override existing env vars by default', () => {
    const env: NodeJS.ProcessEnv = { EXISTING: 'old' };
    applyEnv({ EXISTING: 'new', NEW: 'fresh' }, env);
    expect(env.EXISTING).toBe('old');
    expect(env.NEW).toBe('fresh');
  });

  test('overrides when opted in', () => {
    const env: NodeJS.ProcessEnv = { EXISTING: 'old' };
    applyEnv({ EXISTING: 'new' }, env, { override: true });
    expect(env.EXISTING).toBe('new');
  });
});
