import { relative } from 'node:path';
import { loadWorkflow, type LoadOptions } from '../config.ts';
import type { Colors } from '../colors.ts';
import type { Logger } from '../logger.ts';
import type { Input, Task } from '../types.ts';

export interface ListOptions extends LoadOptions {
  log: Logger;
  colors: Colors;
}

export function runList({ log, colors, file, cwd }: ListOptions): number {
  const { workflow, path } = loadWorkflow({ file, cwd });

  const taskNames = Object.keys(workflow.tasks);
  log.info(colors.dim(relative(cwd ?? process.cwd(), path)));
  if (taskNames.length === 0) {
    log.info(colors.dim('(no tasks defined)'));
    return 0;
  }

  log.info('');
  log.info(`${colors.bold('Tasks')} (${taskNames.length}):`);

  const nameWidth = Math.max(...taskNames.map((n) => n.length));
  for (const name of taskNames) {
    const task = workflow.tasks[name]!;
    log.info(formatTaskLine(name, nameWidth, task, colors));
    const requiredInputs = collectRequiredInputs(task);
    if (requiredInputs.length > 0) {
      for (const [inputName, input] of requiredInputs) {
        log.info(formatInputLine(inputName, input, colors));
      }
    }
  }
  return 0;
}

function formatTaskLine(name: string, nameWidth: number, task: Task, colors: Colors): string {
  const padded = name.padEnd(nameWidth);
  const desc = task.description ?? '';
  return `  ${colors.cyan(padded)}  ${desc}`;
}

function formatInputLine(name: string, input: Input, colors: Colors): string {
  const type = input.type ?? 'string';
  const desc = input.description ?? '';
  const meta = colors.dim(`(${type}, required)`);
  return `      ${colors.yellow(name)}  ${meta}${desc ? `  ${desc}` : ''}`;
}

function collectRequiredInputs(task: Task): Array<[string, Input]> {
  if (!task.inputs) return [];
  return Object.entries(task.inputs).filter(([, input]) => input.required === true);
}
