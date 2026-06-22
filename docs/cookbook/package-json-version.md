# Reading values from `package.json`

A small, reusable TypeScript action that extracts the version (and anything else) from a JSON file and returns it as
step outputs. Drop-in for any task that needs the project's own version.

## The action

```ts
// scripts/version.action.ts
import { readFileSync } from 'node:fs';

type Inputs = {
  path?: string; // defaults to ./package.json
  field?: string; // which top-level key to require, defaults to 'version'
};

type Context = {
  cwd: string;
  log: { info(m: string): void; warn(m: string): void };
};

export function action(inputs: Inputs, context: Context) {
  const path = inputs.path ?? 'package.json';
  const field = inputs.field ?? 'version';

  const text = readFileSync(path, 'utf-8');
  const pkg = JSON.parse(text) as Record<string, unknown>;

  const value = pkg[field];
  if (value === undefined) throw new Error(`${path} has no '${field}' field`);
  if (typeof value !== 'string') throw new Error(`${path}.${field} is not a string`);

  context.log.info(`Read ${field}=${value} from ${path}`);

  return {
    [field]: value,
    // Useful adjacent fields, returned only when present so they don't surprise.
    ...(typeof pkg.name === 'string' ? { name: pkg.name } : {}),
    ...(typeof pkg.private === 'boolean' ? { private: pkg.private } : {}),
  };
}
```

## Calling it from a task

```yml
# zorb.yml
tasks:
  whoami:
    description: Print the package name and version
    steps:
      - id: pkg
        uses: ./scripts/version.action

      - env:
          NAME: ${{ steps.pkg.outputs.name }}
          VERSION: ${{ steps.pkg.outputs.version }}
        run: echo "$NAME @ $VERSION"
```

```sh
$ zorb run whoami
> Step 1/2: ./scripts/version.action
Read version=1.2.3 from package.json
> Step 2/2: echo "$NAME @ $VERSION"
my-app @ 1.2.3
```

## Reading other fields

The `field` input lets the same action lift any top-level string:

```yml
- id: tag
  uses: ./scripts/version.action
  with:
    path: ./apps/web/package.json
    field: version
```

For nested fields (`engines.node`, `repository.url`) it's faster to write a one-off action than to push generic
path-traversal into this one. Actions are cheap — the value of a reusable one drops fast once it stops being
two-line.

## Without the action

If you don't want a TypeScript file, `jq` from a shell step does the same job:

```yml
- id: version
  run: |
    set -euo pipefail
    VERSION=$(jq -r .version package.json)
    echo "version=$VERSION" >> "$ZORB_OUTPUT"
```

Three tradeoffs to weigh between the two:

| Concern             | Action                            | Shell + `jq`                          |
| ------------------- | --------------------------------- | ------------------------------------- |
| Dependency          | Bun (bundled with the binary)     | `jq` (system, not always installed)   |
| Typed outputs       | Native — return an object         | String values via `$ZORB_OUTPUT`      |
| Error messages      | Throw with file/field context     | Whatever `jq` says + manual handling  |
| Testability         | `bun test` against `action()`     | Shell, harder to unit-test            |

The action wins for anything that gets reused; the shell version is fine for a one-off.

## Testing the action

`bun:test` covers the action without spinning up the runner:

```ts
// scripts/version.action.test.ts
import { test, expect } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { action } from './version.action.ts';

const ctx = {
  cwd: process.cwd(),
  log: { info: () => {}, warn: () => {} },
};

test('reads the version field by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
  const path = join(dir, 'package.json');
  writeFileSync(path, JSON.stringify({ name: 'demo', version: '0.1.0' }));

  const out = action({ path }, ctx);
  expect(out).toEqual({ name: 'demo', version: '0.1.0' });
});

test('throws when the requested field is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
  const path = join(dir, 'package.json');
  writeFileSync(path, JSON.stringify({ name: 'demo' }));

  expect(() => action({ path }, ctx)).toThrow(/no 'version' field/);
});
```

Run with `bun test scripts/version.action.test.ts`. Same fast feedback loop as any other unit test.

## See also

- **[Writing actions](../guide/actions.md)** — the full `action(inputs, context)` contract.
- **[Tag, build, push a release](./tag-build-push-release.md)** — uses this exact action as the first step of a
  release pipeline.
- **[Concepts → Outputs](../guide/concepts.md#outputs)** — how the return value becomes step outputs.
