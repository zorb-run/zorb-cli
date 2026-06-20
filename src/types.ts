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

export interface ActionRuntimeDefaults {
  /** CLI template for invoking the runner script. {0} is the runner script path. */
  bin?: string;
}

export interface ActionDefaults {
  js?: ActionRuntimeDefaults;
  py?: ActionRuntimeDefaults;
}

export interface Defaults {
  run?: RunDefaults;
  action?: ActionDefaults;
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

export type Backoff = 'linear' | 'exponential';

interface BaseStep {
  id?: string;
  name?: string;
  env?: EnvMap;
  /** Raw duration string from YAML (e.g. '30s'). Validated at parse time. */
  timeout?: string;
  /** Number of additional attempts after the first. Total attempts = retries + 1. */
  retries?: number;
  /** Delay strategy between retry attempts. Defaults to no delay. */
  backoff?: Backoff;
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
  /** Override the runtime-launch template for this step. {0} = runner script path. */
  bin?: string;
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
  secrets?: ActionStep[];
  tasks: Record<string, Task>;
}
