import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkflow } from '../src/config.ts';

const EXAMPLES_DIR = new URL('../examples/', import.meta.url).pathname;

function listExampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((entry) => entry.endsWith('.yml'));
}

describe('examples/', () => {
  const files = listExampleFiles();

  test('directory contains at least one example', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s parses and exposes at least one task', (name) => {
    const file = join(EXAMPLES_DIR, name);
    const { workflow, path } = loadWorkflow({ file });
    expect(path).toBe(file);
    expect(Object.keys(workflow.tasks).length).toBeGreaterThan(0);
  });
});
