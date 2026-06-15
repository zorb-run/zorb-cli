import { relative } from 'node:path';
import type { Colors } from '../colors.ts';
import { loadWorkflow, type LoadOptions } from '../config.ts';
import {
  interpolateMap,
  interpolateWith,
  type InterpolationContext,
} from '../expressions.ts';
import { parseWithPairs, resolveInputs } from '../inputs.ts';
import type { Logger } from '../logger.ts';
import { isShellStep, type Input, type Step, type WithValue } from '../types.ts';

export interface RunOptions extends LoadOptions {
  log: Logger;
  colors: Colors;
  taskName: string;
  withPairs: string[];
}

export function runRun({ log, colors, taskName, file, cwd, withPairs }: RunOptions): number {
  const { workflow, path } = loadWorkflow({ file, cwd });

  const task = workflow.tasks[taskName];
  if (!task) {
    log.error(`task not found: '${taskName}'`);
    const available = Object.keys(workflow.tasks);
    if (available.length > 0) {
      log.hint(`available tasks: ${available.join(', ')}`);
    } else {
      log.hint(`zorb.yml defines no tasks`);
    }
    return 1;
  }

  const provided = parseWithPairs(withPairs);
  const inputs = resolveInputs({
    taskName,
    defs: task.inputs,
    provided,
    onWarning: (msg) => log.warn(msg),
  });
  const ctx: InterpolationContext = { inputs };

  log.verbose(`resolved ${Object.keys(inputs).length} input(s)`);
  log.info(formatHeader(taskName, task.description, colors));

  printInputs(log, colors, inputs, task.inputs, provided);
  printSteps(log, colors, task.steps);

  // Interpolation can throw on complex expressions (A5 territory), so only
  // perform it when --debug actually wants to see the resolved values.
  // At normal/verbose levels, interpolation is deferred to execution (A4).
  if (log.level === 'debug') {
    log.debug('resolved task env:', task.env ? interpolateMap(task.env, ctx) : {});
    log.debug('resolved steps:', task.steps.map((step) => resolveStep(step, ctx)));
  }

  log.info('');
  log.info(
    colors.dim(`(scaffold) ${task.steps.length} step(s) ready — execution arrives in A4`),
  );
  log.info(colors.dim(`  workflow: ${relative(cwd ?? process.cwd(), path)}`));
  return 0;
}

interface ResolvedStep {
  name?: string;
  id?: string;
  preview: string;
  env: Record<string, string>;
  with?: Record<string, WithValue>;
}

function resolveStep(step: Step, ctx: InterpolationContext): ResolvedStep {
  const env = step.env ? interpolateMap(step.env, ctx) : {};
  if (isShellStep(step)) {
    return { name: step.name, id: step.id, preview: oneLine(step.run), env };
  }
  return {
    name: step.name,
    id: step.id,
    preview: step.uses,
    env,
    with: step.with ? interpolateWith(step.with, ctx) : undefined,
  };
}

function oneLine(text: string): string {
  const first = text.split('\n', 1)[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function formatHeader(name: string, desc: string | undefined, colors: Colors): string {
  return desc ? `${colors.bold(colors.cyan(name))} — ${desc}` : colors.bold(colors.cyan(name));
}

function printInputs(
  log: Logger,
  colors: Colors,
  resolved: Record<string, WithValue>,
  defs: Record<string, Input> | undefined,
  provided: Record<string, string>,
): void {
  if (log.level === 'normal' || log.level === 'quiet') return;
  const keys = Object.keys(resolved);
  if (keys.length === 0) return;
  log.info(`  ${colors.bold('Inputs')}:`);
  const width = Math.max(...keys.map((k) => k.length));
  for (const name of keys) {
    const tag = name in provided
      ? colors.gray('(provided)')
      : defs?.[name]?.default !== undefined
        ? colors.gray('(default)')
        : colors.gray('(unknown)');
    log.info(`    ${colors.yellow(name.padEnd(width))} = ${formatValue(resolved[name]!)}  ${tag}`);
  }
}

function printSteps(log: Logger, colors: Colors, steps: Step[]): void {
  if (log.level === 'normal' || log.level === 'quiet') return;
  log.info(`  ${colors.bold('Steps')} (${steps.length}):`);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const preview = isShellStep(step) ? oneLine(step.run) : step.uses;
    const label = step.name ?? step.id ?? preview;
    const suffix = step.name && preview !== step.name ? colors.dim(` — ${preview}`) : '';
    log.info(`    ${i + 1}. ${label}${suffix}`);
  }
}

function formatValue(v: WithValue): string {
  return typeof v === 'string' ? `"${v}"` : String(v);
}
