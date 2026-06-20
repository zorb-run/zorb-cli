import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Colors } from '../colors.ts';
import type { Logger } from '../logger.ts';

export interface InitOptions {
  log: Logger;
  colors: Colors;
  cwd?: string;
}

const TEMPLATE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/zorb-run/zorb-cli/main/zorb.schema.json

# Welcome to zorb! Edit this file to define your workflow's tasks.
# Run \`zorb list\` to see available tasks and \`zorb run <task>\` to execute one.

tasks:
  hello:
    description: Print a greeting
    steps:
      - run: echo "Hello, zorb!"
`;

export function runInit({ log, colors, cwd }: InitOptions): number {
  const dir = resolve(cwd ?? process.cwd());
  const target = resolve(dir, 'zorb.yml');
  const display = relative(dir, target) || target;

  // 'wx' fails atomically if the file already exists, so we don't need a
  // separate existsSync check (which would also leave a TOCTOU window).
  // EEXIST maps to the same "already exists" UX; other fs errors (EACCES,
  // ENOSPC, ENOENT on a stale cwd) get a clean message instead of bubbling
  // out of the CLI as an unhandled exception.
  try {
    writeFileSync(target, TEMPLATE, { flag: 'wx' });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      log.error(`zorb.yml already exists at ${display}`);
      log.hint(`Remove it first if you want to start over.`);
      return 1;
    }
    log.error(`failed to create zorb.yml: ${err.message}`);
    return 1;
  }

  log.info(`Created ${colors.cyan(display)}`);
  log.hint(`Run '${colors.bold('zorb list')}' to see the example task.`);
  return 0;
}
