export class RunContext {
  private readonly _secrets = new Map<string, string>();
  private readonly _dynamicEnv = new Map<string, string>();
  private readonly _stepOutputs = new Map<string, Record<string, unknown>>();

  setSecret(name: string, value: string): boolean {
    if (this._secrets.has(name)) return false;
    this._secrets.set(name, value);
    return true;
  }

  hasSecret(name: string): boolean {
    return this._secrets.has(name);
  }

  getSecretsSnapshot(): Record<string, string> {
    return Object.fromEntries(this._secrets);
  }

  setEnv(name: string, value: string): void {
    this._dynamicEnv.set(name, value);
  }

  getDynamicEnv(): Record<string, string> {
    return Object.fromEntries(this._dynamicEnv);
  }

  setStepOutputs(stepId: string, outputs: Record<string, unknown>): void {
    this._stepOutputs.set(stepId, outputs);
  }

  getStepOutputs(stepId: string): Record<string, unknown> | undefined {
    return this._stepOutputs.get(stepId);
  }

  getStepsSnapshot(): Record<string, { outputs: Record<string, unknown> }> {
    const out: Record<string, { outputs: Record<string, unknown> }> = Object.create(null);
    for (const [id, outputs] of this._stepOutputs) out[id] = { outputs };
    return out;
  }

  get hasSecrets(): boolean {
    return this._secrets.size > 0;
  }

  mask(text: string): string {
    if (this._secrets.size === 0) return text;
    let result = text;
    for (const value of this._secrets.values()) {
      if (value.length > 0) result = result.split(value).join('***');
    }
    return result;
  }
}
