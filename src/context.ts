export class RunContext {
  private readonly _secrets = new Map<string, string>();
  private readonly _dynamicEnv = new Map<string, string>();

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
