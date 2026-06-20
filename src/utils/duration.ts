export class DurationError extends Error {
  override readonly name = 'DurationError';
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

// Accepts integer or decimal followed by a unit: 500ms, 30s, 5m, 1.5h.
// Whitespace around the value is allowed; multi-unit strings ("1m30s") are not.
const PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/;

export function parseDuration(input: string): number {
  const m = PATTERN.exec(input);
  if (!m) {
    throw new DurationError(`invalid duration: ${JSON.stringify(input)} (expected e.g. '500ms', '30s', '5m', '1h')`);
  }
  const value = Number.parseFloat(m[1]!);
  const unit = m[2]!;
  const ms = Math.round(value * UNIT_MS[unit]!);
  if (ms <= 0) {
    throw new DurationError(`duration must be greater than zero: ${JSON.stringify(input)}`);
  }
  return ms;
}
