import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
  type Pair,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type {
  Defaults,
  Docker,
  EnvMap,
  Input,
  InputType,
  RunDefaults,
  Step,
  Task,
  WithMap,
  WithValue,
  Workflow,
} from './types.ts';

export class WorkflowError extends Error {
  override readonly name = 'WorkflowError';
  constructor(
    message: string,
    public readonly file: string,
    public readonly line?: number,
    public readonly col?: number,
    public readonly hint?: string,
  ) {
    super(message);
  }

  format(): string {
    const at =
      this.line !== undefined
        ? `\n  at ${this.file}:${this.line}${this.col !== undefined ? `:${this.col}` : ''}`
        : this.file
          ? `\n  at ${this.file}`
          : '';
    const hint = this.hint ? `\n  hint: ${this.hint}` : '';
    return `${this.message}${at}${hint}`;
  }
}

export interface FindOptions {
  cwd?: string;
}

export function findWorkflowFile(opts: FindOptions = {}): string | undefined {
  let dir = resolve(opts.cwd ?? process.cwd());
  while (true) {
    const candidate = join(dir, 'zorb.yml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadOptions {
  file?: string;
  cwd?: string;
}

export interface LoadedWorkflow {
  workflow: Workflow;
  path: string;
}

export function loadWorkflow(opts: LoadOptions = {}): LoadedWorkflow {
  const cwd = resolve(opts.cwd ?? process.cwd());
  let filePath: string;

  if (opts.file) {
    filePath = isAbsolute(opts.file) ? opts.file : resolve(cwd, opts.file);
    if (!existsSync(filePath)) {
      throw new WorkflowError(`workflow file not found: ${opts.file}`, filePath);
    }
  } else {
    const found = findWorkflowFile({ cwd });
    if (!found) {
      throw new WorkflowError(
        `couldn't find zorb.yml in ${cwd} or any parent directory`,
        '',
        undefined,
        undefined,
        `pass --file <path> or create a zorb.yml`,
      );
    }
    filePath = found;
  }

  const text = readFileSync(filePath, 'utf-8');
  const workflow = parseWorkflow(text, filePath);
  return { workflow, path: filePath };
}

export function parseWorkflow(text: string, file = '<inline>'): Workflow {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });

  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    const pos = first.pos?.[0] !== undefined ? lineCounter.linePos(first.pos[0]) : undefined;
    throw new WorkflowError(first.message, file, pos?.line, pos?.col);
  }

  const root = doc.contents;
  const ctx: Ctx = { file, lineCounter };

  if (root === null) {
    throw new WorkflowError('workflow file is empty', file);
  }
  if (!isMap(root)) {
    fail(ctx, root, 'workflow root must be a map');
  }

  return validateWorkflow(ctx, root);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Ctx {
  file: string;
  lineCounter: LineCounter;
}

const WORKFLOW_KEYS = ['version', 'defaults', 'env', 'tasks'] as const;
const TASK_KEYS = ['description', 'inputs', 'defaults', 'env', 'steps'] as const;
const INPUT_KEYS = ['description', 'type', 'required', 'default'] as const;
const DEFAULTS_KEYS = ['run'] as const;
const RUN_DEFAULTS_KEYS = ['shell', 'cwd', 'env'] as const;
const STEP_BASE_KEYS = ['id', 'name', 'env'] as const;
const STEP_RUN_KEYS = [...STEP_BASE_KEYS, 'run', 'cwd', 'shell', 'docker'] as const;
const STEP_USES_KEYS = [...STEP_BASE_KEYS, 'uses', 'with'] as const;
const STEP_ALL_KEYS = [...STEP_BASE_KEYS, 'run', 'cwd', 'shell', 'docker', 'uses', 'with'] as const;
const DOCKER_KEYS = ['image', 'volumes', 'network', 'workdir', 'platform', 'entrypoint', 'pull'] as const;
const INPUT_TYPES: readonly InputType[] = ['string', 'number', 'boolean'];
const DOCKER_PULL: ReadonlyArray<NonNullable<Docker['pull']>> = ['always', 'never', 'if-not-present'];

function locOf(node: Node | undefined, lc: LineCounter): { line?: number; col?: number } {
  if (!node?.range) return {};
  const { line, col } = lc.linePos(node.range[0]);
  return { line, col };
}

function fail(ctx: Ctx, node: Node | undefined, message: string, hint?: string): never {
  const { line, col } = locOf(node, ctx.lineCounter);
  throw new WorkflowError(message, ctx.file, line, col, hint);
}

function requireMap(ctx: Ctx, node: Node | null, where: string): YAMLMap {
  if (!isMap(node)) fail(ctx, node ?? undefined, `${where} must be a map`);
  return node;
}

function requireSeq(ctx: Ctx, node: Node | null, where: string): YAMLSeq {
  if (!isSeq(node)) fail(ctx, node ?? undefined, `${where} must be a list`);
  return node;
}

function requireScalar(ctx: Ctx, node: Node | null, where: string): Scalar {
  if (!isScalar(node)) fail(ctx, node ?? undefined, `${where} must be a scalar value`);
  return node;
}

function requireString(ctx: Ctx, node: Node | null, where: string): string {
  const s = requireScalar(ctx, node, where);
  if (typeof s.value !== 'string') fail(ctx, s, `${where} must be a string`);
  return s.value;
}

function requireBoolean(ctx: Ctx, node: Node | null, where: string): boolean {
  const s = requireScalar(ctx, node, where);
  if (typeof s.value !== 'boolean') fail(ctx, s, `${where} must be a boolean (true or false)`);
  return s.value;
}

function requireInteger(ctx: Ctx, node: Node | null, where: string): number {
  const s = requireScalar(ctx, node, where);
  if (typeof s.value !== 'number' || !Number.isInteger(s.value)) {
    fail(ctx, s, `${where} must be an integer`);
  }
  return s.value;
}

function pairKey(pair: Pair): { node: Scalar; name: string } {
  const node = pair.key as Scalar;
  return { node, name: String(node.value) };
}

function checkAllowedKeys(ctx: Ctx, map: YAMLMap, allowed: readonly string[], where: string) {
  for (const pair of map.items) {
    const { node, name } = pairKey(pair);
    if (!allowed.includes(name)) {
      fail(ctx, node, `unknown key '${name}' in ${where}`, suggestSimilar(name, allowed));
    }
  }
}

function suggestSimilar(input: string, options: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const opt of options) {
    const d = levenshtein(input, opt);
    if (d > 0 && d <= 2 && (!best || d < best.distance)) best = { name: opt, distance: d };
  }
  return best ? `did you mean '${best.name}'?` : undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

function getPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => String((p.key as Scalar).value) === key);
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateWorkflow(ctx: Ctx, root: YAMLMap): Workflow {
  checkAllowedKeys(ctx, root, WORKFLOW_KEYS, 'workflow');

  const versionPair = getPair(root, 'version');
  let version = 1;
  if (versionPair) {
    version = requireInteger(ctx, versionPair.value as Node, 'version');
    if (version !== 1) {
      fail(ctx, versionPair.value as Node, `unsupported workflow version: ${version}`, 'only version 1 is supported');
    }
  }

  const defaultsPair = getPair(root, 'defaults');
  const defaults = defaultsPair ? validateDefaults(ctx, defaultsPair.value as Node, 'defaults') : undefined;

  const envPair = getPair(root, 'env');
  const env = envPair ? validateEnv(ctx, envPair.value as Node, 'env') : undefined;

  const tasksPair = getPair(root, 'tasks');
  if (!tasksPair) fail(ctx, root, `missing required key 'tasks'`);
  const tasks = validateTasks(ctx, tasksPair.value as Node);

  return { version, defaults, env, tasks };
}

function validateTasks(ctx: Ctx, node: Node): Record<string, Task> {
  const map = requireMap(ctx, node, 'tasks');
  if (map.items.length === 0) fail(ctx, map, `'tasks' must define at least one task`);
  const out: Record<string, Task> = Object.create(null);
  for (const pair of map.items) {
    const { node: keyNode, name } = pairKey(pair);
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
      fail(ctx, keyNode, `invalid task name '${name}'`, 'task names must start with a letter or underscore and contain only letters, numbers, hyphens, and underscores');
    }
    if (Object.hasOwn(out, name)) fail(ctx, keyNode, `duplicate task '${name}'`);
    out[name] = validateTask(ctx, pair.value as Node, name);
  }
  return out;
}

function validateTask(ctx: Ctx, node: Node, taskName: string): Task {
  const map = requireMap(ctx, node, `task '${taskName}'`);
  checkAllowedKeys(ctx, map, TASK_KEYS, `task '${taskName}'`);

  const stepsPair = getPair(map, 'steps');
  if (!stepsPair) fail(ctx, map, `task '${taskName}' is missing required key 'steps'`);

  const description = pickString(ctx, map, 'description', `task '${taskName}'.description`);
  const inputs = pickInputs(ctx, map, taskName);
  const defaultsPair = getPair(map, 'defaults');
  const defaults = defaultsPair
    ? validateDefaults(ctx, defaultsPair.value as Node, `task '${taskName}'.defaults`)
    : undefined;
  const envPair = getPair(map, 'env');
  const env = envPair ? validateEnv(ctx, envPair.value as Node, `task '${taskName}'.env`) : undefined;
  const steps = validateSteps(ctx, stepsPair.value as Node, taskName);

  return { description, inputs, defaults, env, steps };
}

function pickString(ctx: Ctx, map: YAMLMap, key: string, where: string): string | undefined {
  const pair = getPair(map, key);
  if (!pair) return undefined;
  return requireString(ctx, pair.value as Node, where);
}

function pickInputs(ctx: Ctx, taskMap: YAMLMap, taskName: string): Record<string, Input> | undefined {
  const pair = getPair(taskMap, 'inputs');
  if (!pair) return undefined;
  const map = requireMap(ctx, pair.value as Node, `task '${taskName}'.inputs`);
  const out: Record<string, Input> = Object.create(null);
  for (const inputPair of map.items) {
    const { node: keyNode, name } = pairKey(inputPair);
    out[name] = validateInput(ctx, inputPair.value as Node, `task '${taskName}'.inputs.${name}`, keyNode);
  }
  return out;
}

function validateInput(ctx: Ctx, node: Node, where: string, _keyNode: Scalar): Input {
  const map = requireMap(ctx, node, where);
  checkAllowedKeys(ctx, map, INPUT_KEYS, where);
  const input: Input = {};
  for (const pair of map.items) {
    const { node: keyNode, name } = pairKey(pair);
    const value = pair.value as Node;
    switch (name) {
      case 'description':
        input.description = requireString(ctx, value, `${where}.description`);
        break;
      case 'type': {
        const t = requireString(ctx, value, `${where}.type`);
        if (!INPUT_TYPES.includes(t as InputType)) {
          fail(ctx, value, `${where}.type must be one of: ${INPUT_TYPES.join(', ')}`);
        }
        input.type = t as InputType;
        break;
      }
      case 'required':
        input.required = requireBoolean(ctx, value, `${where}.required`);
        break;
      case 'default':
        input.default = requireWithValue(ctx, value, `${where}.default`);
        break;
      default:
        fail(ctx, keyNode, `unknown key '${name}' in ${where}`);
    }
  }
  return input;
}

function validateDefaults(ctx: Ctx, node: Node, where: string): Defaults {
  const map = requireMap(ctx, node, where);
  checkAllowedKeys(ctx, map, DEFAULTS_KEYS, where);
  const runPair = getPair(map, 'run');
  return { run: runPair ? validateRunDefaults(ctx, runPair.value as Node, `${where}.run`) : undefined };
}

function validateRunDefaults(ctx: Ctx, node: Node, where: string): RunDefaults {
  const map = requireMap(ctx, node, where);
  checkAllowedKeys(ctx, map, RUN_DEFAULTS_KEYS, where);
  const out: RunDefaults = {};
  const shellPair = getPair(map, 'shell');
  if (shellPair) out.shell = requireString(ctx, shellPair.value as Node, `${where}.shell`);
  const cwdPair = getPair(map, 'cwd');
  if (cwdPair) out.cwd = requireString(ctx, cwdPair.value as Node, `${where}.cwd`);
  const envPair = getPair(map, 'env');
  if (envPair) out.env = validateEnv(ctx, envPair.value as Node, `${where}.env`);
  return out;
}

function validateEnv(ctx: Ctx, node: Node, where: string): EnvMap {
  const map = requireMap(ctx, node, where);
  const out: EnvMap = Object.create(null);
  for (const pair of map.items) {
    const { name } = pairKey(pair);
    out[name] = requireString(ctx, pair.value as Node, `${where}.${name}`);
  }
  return out;
}

function validateSteps(ctx: Ctx, node: Node, taskName: string): Step[] {
  const seq = requireSeq(ctx, node, `task '${taskName}'.steps`);
  if (seq.items.length === 0) fail(ctx, seq, `task '${taskName}' must have at least one step`);
  const seenIds = new Set<string>();
  const steps: Step[] = [];
  for (let i = 0; i < seq.items.length; i++) {
    const where = `task '${taskName}'.steps[${i}]`;
    const step = validateStep(ctx, seq.items[i] as Node, where);
    if (step.id) {
      if (seenIds.has(step.id)) {
        fail(ctx, seq.items[i] as Node, `duplicate step id '${step.id}' in task '${taskName}'`);
      }
      seenIds.add(step.id);
    }
    steps.push(step);
  }
  return steps;
}

function validateStep(ctx: Ctx, node: Node, where: string): Step {
  const map = requireMap(ctx, node, where);
  checkAllowedKeys(ctx, map, STEP_ALL_KEYS, where);

  const runPair = getPair(map, 'run');
  const usesPair = getPair(map, 'uses');

  if (!runPair && !usesPair) {
    fail(ctx, map, `${where} must define either 'run' or 'uses'`);
  }
  if (runPair && usesPair) {
    fail(ctx, usesPair.value as Node ?? map, `${where} cannot define both 'run' and 'uses'`);
  }

  if (runPair) {
    checkAllowedKeys(ctx, map, STEP_RUN_KEYS, where);
    return validateRunStep(ctx, map, where);
  }
  checkAllowedKeys(ctx, map, STEP_USES_KEYS, where);
  return validateUsesStep(ctx, map, where);
}

function validateRunStep(ctx: Ctx, map: YAMLMap, where: string): Step {
  const out = {
    run: requireString(ctx, getPair(map, 'run')!.value as Node, `${where}.run`),
  } as Step & { run: string };
  applyStepBase(ctx, map, where, out);
  const cwd = getPair(map, 'cwd');
  if (cwd) (out as { cwd?: string }).cwd = requireString(ctx, cwd.value as Node, `${where}.cwd`);
  const shell = getPair(map, 'shell');
  if (shell) (out as { shell?: string }).shell = requireString(ctx, shell.value as Node, `${where}.shell`);
  const docker = getPair(map, 'docker');
  if (docker) (out as { docker?: Docker | string }).docker = validateDocker(ctx, docker.value as Node, `${where}.docker`);
  return out;
}

function validateUsesStep(ctx: Ctx, map: YAMLMap, where: string): Step {
  const out = {
    uses: requireString(ctx, getPair(map, 'uses')!.value as Node, `${where}.uses`),
  } as Step & { uses: string };
  applyStepBase(ctx, map, where, out);
  const withPair = getPair(map, 'with');
  if (withPair) (out as { with?: WithMap }).with = validateWith(ctx, withPair.value as Node, `${where}.with`);
  return out;
}

function applyStepBase(ctx: Ctx, map: YAMLMap, where: string, target: { id?: string; name?: string; env?: EnvMap }) {
  const idPair = getPair(map, 'id');
  if (idPair) {
    const id = requireString(ctx, idPair.value as Node, `${where}.id`);
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id)) {
      fail(
        ctx,
        idPair.value as Node,
        `invalid step id '${id}' in ${where}`,
        'step ids must start with a letter or underscore and contain only letters, numbers, hyphens, and underscores',
      );
    }
    target.id = id;
  }
  const namePair = getPair(map, 'name');
  if (namePair) target.name = requireString(ctx, namePair.value as Node, `${where}.name`);
  const envPair = getPair(map, 'env');
  if (envPair) target.env = validateEnv(ctx, envPair.value as Node, `${where}.env`);
}

function validateWith(ctx: Ctx, node: Node, where: string): WithMap {
  const map = requireMap(ctx, node, where);
  const out: WithMap = Object.create(null);
  for (const pair of map.items) {
    const { name } = pairKey(pair);
    out[name] = requireWithValue(ctx, pair.value as Node, `${where}.${name}`);
  }
  return out;
}

function requireWithValue(ctx: Ctx, node: Node, where: string): WithValue {
  const s = requireScalar(ctx, node, where);
  if (typeof s.value === 'string' || typeof s.value === 'number' || typeof s.value === 'boolean') {
    return s.value;
  }
  fail(ctx, s, `${where} must be a string, number, or boolean`);
}

function validateDocker(ctx: Ctx, node: Node, where: string): Docker | string {
  if (isScalar(node)) {
    return requireString(ctx, node, where);
  }
  const map = requireMap(ctx, node, where);
  checkAllowedKeys(ctx, map, DOCKER_KEYS, where);
  const imagePair = getPair(map, 'image');
  if (!imagePair) fail(ctx, map, `${where} must include 'image'`);
  const out: Docker = {
    image: requireString(ctx, imagePair.value as Node, `${where}.image`),
  };
  const volumes = getPair(map, 'volumes');
  if (volumes) out.volumes = validateStringList(ctx, volumes.value as Node, `${where}.volumes`);
  const network = getPair(map, 'network');
  if (network) out.network = requireString(ctx, network.value as Node, `${where}.network`);
  const workdir = getPair(map, 'workdir');
  if (workdir) out.workdir = requireString(ctx, workdir.value as Node, `${where}.workdir`);
  const platform = getPair(map, 'platform');
  if (platform) out.platform = requireString(ctx, platform.value as Node, `${where}.platform`);
  const entrypoint = getPair(map, 'entrypoint');
  if (entrypoint) out.entrypoint = requireString(ctx, entrypoint.value as Node, `${where}.entrypoint`);
  const pull = getPair(map, 'pull');
  if (pull) {
    const v = requireString(ctx, pull.value as Node, `${where}.pull`);
    if (!DOCKER_PULL.includes(v as Docker['pull'] & string)) {
      fail(ctx, pull.value as Node, `${where}.pull must be one of: ${DOCKER_PULL.join(', ')}`);
    }
    out.pull = v as Docker['pull'];
  }
  return out;
}

function validateStringList(ctx: Ctx, node: Node, where: string): string[] {
  const seq = requireSeq(ctx, node, where);
  return seq.items.map((item, i) => requireString(ctx, item as Node, `${where}[${i}]`));
}
