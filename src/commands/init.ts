import { existsSync, writeFileSync } from 'node:fs';
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

  if (existsSync(target)) {
    log.error(`zorb.yml already exists at ${relative(dir, target) || target}`);
    log.hint(`Remove it first if you want to start over.`);
    return 1;
  }

  writeFileSync(target, TEMPLATE, { flag: 'wx' });
  log.info(`Created ${colors.cyan(relative(dir, target) || target)}`);
  log.hint(`Run '${colors.bold('zorb list')}' to see the example task.`);
  return 0;
}
