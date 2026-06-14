export type EnvMap = Record<string, string>;

export type WithValue = string | number | boolean;
export type WithMap = Record<string, WithValue>;

export type InputType = 'string' | 'number' | 'boolean';

export interface Input {
  description?: string;
  type?: InputType;
  required?: boolean;
  default?: WithValue;
}

export interface RunDefaults {
  shell?: string;
  cwd?: string;
  env?: EnvMap;
}

export interface Defaults {
  run?: RunDefaults;
}

export interface Docker {
  image: string;
  volumes?: string[];
  network?: string;
  workdir?: string;
  platform?: string;
  entrypoint?: string;
  pull?: 'always' | 'never' | 'if-not-present';
}

interface BaseStep {
  id?: string;
  name?: string;
  env?: EnvMap;
}

export interface ShellStep extends BaseStep {
  run: string;
  cwd?: string;
  shell?: string;
  docker?: Docker | string;
}

export interface ActionStep extends BaseStep {
  uses: string;
  with?: WithMap;
}

export type Step = ShellStep | ActionStep;

export function isShellStep(step: Step): step is ShellStep {
  return 'run' in step;
}

export function isActionStep(step: Step): step is ActionStep {
  return 'uses' in step;
}

export interface Task {
  description?: string;
  inputs?: Record<string, Input>;
  defaults?: Defaults;
  env?: EnvMap;
  steps: Step[];
}

export interface Workflow {
  version: number;
  defaults?: Defaults;
  env?: EnvMap;
  tasks: Record<string, Task>;
}
