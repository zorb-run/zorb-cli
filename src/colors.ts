const RESET = '\x1b[0m';

const CODES = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
} as const;

type Code = keyof typeof CODES;
type Painter = (input: string) => string;

export interface Colors extends Record<Code, Painter> {
  enabled: boolean;
}

export function createColors(enabled: boolean): Colors {
  const paint = (code: string): Painter => (s) => (enabled ? `${code}${s}${RESET}` : s);
  const out = { enabled } as Colors;
  for (const key of Object.keys(CODES) as Code[]) {
    out[key] = paint(CODES[key]);
  }
  return out;
}

export interface ColorEnvOptions {
  noColorFlag?: boolean;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

export function shouldColor({ noColorFlag = false, env = process.env, isTTY }: ColorEnvOptions = {}): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (isTTY === undefined) return Boolean(process.stdout.isTTY);
  return isTTY;
}
