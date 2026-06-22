# Writing actions

Actions are code files invoked from a `uses:` step. They run as a subprocess, take typed inputs, talk to zorb through a
small `context` object, and return outputs the rest of the workflow can use.

This guide walks through what an action looks like in each supported language, the `context` API, how outputs flow back
to the workflow, and how to test an action locally.

## At a glance

An action is a function called `action` that takes two arguments — `inputs` and `context` — and returns an object.

```js
// scripts/greet.action.cjs
module.exports.action = (inputs, context) => {
  context.log.info(`Hello, ${inputs.name}!`);
  return { greeted: inputs.name };
};
```

```yml
# zorb.yml
tasks:
  greet:
    steps:
      - id: g
        uses: ./scripts/greet.action
        with:
          name: world
      - name: Show what we returned
        env:
          GREETED: ${{ steps.g.outputs.greeted }}
        run: echo "Greeted $GREETED"
```

```sh
zorb run greet
```

## Supported file types

| Extension      | Runner       | Default launcher |
| -------------- | ------------ | ---------------- |
| `.js` / `.cjs` | `runner.cjs` | `bun {0}`        |
| `.mjs`         | `runner.cjs` | `bun {0}`        |
| `.ts`          | `runner.cjs` | `bun {0}`        |
| `.py`          | `runner.py`  | `python3 {0}`    |

The default launcher templates can be overridden per workflow, per task, or per step via `defaults.action.<lang>.bin` or
the step's `bin:` field — see [Workflow format](../reference/workflow.md#defaults). The `{0}` placeholder is the path to
the runner script that zorb ships.

## The function contract

An action exports a function (named `action` by default) with the signature:

```ts
function action(inputs: object, context: Context): object | Promise<object>;
```

- **`inputs`** — an object built from the step's `with:` block. Values keep the JSON types you supplied (strings,
  numbers, booleans, arrays).
- **`context`** — described below.
- **Return value** — an object whose keys become step outputs. Returning `undefined` is fine; later steps just won't see
  any outputs from this one.

Async actions are supported in JavaScript/TypeScript (return a `Promise`). Python actions are synchronous.

### JavaScript / TypeScript

```ts
// scripts/version.action.ts
import { readFileSync } from 'node:fs';

export function action(inputs: { path?: string }, context: Context) {
  const path = inputs.path ?? 'package.json';
  const pkg = JSON.parse(readFileSync(path, 'utf-8'));
  context.log.info(`Detected version ${pkg.version}`);
  return { version: pkg.version, name: pkg.name };
}

type Context = {
  cwd: string;
  taskName: string;
  stepId?: string;
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void };
  setSecret(name: string, value: string): void;
  setEnv(name: string, value: string): void;
};
```

`.js` and `.cjs` files may use `module.exports.action = …`, and `module.exports = …` is also honoured when the function
name is the default `action`.

### Python

```py
# scripts/version.action.py
import json

def action(inputs, context):
    path = inputs.get("path", "package.json")
    with open(path) as f:
        pkg = json.load(f)
    context.log.info(f"Detected version {pkg['version']}")
    return {"version": pkg["version"], "name": pkg["name"]}
```

Python actions are loaded by `importlib`, so any helpers can live alongside the action file as ordinary modules.

## The context object

| Field                     | Description                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `context.cwd`             | The workflow's working directory (the directory containing `zorb.yml`).                                |
| `context.taskName`        | The task currently being executed.                                                                     |
| `context.stepId`          | The `id:` of the current step, if it has one.                                                          |
| `context.log.debug(msg)`  | Print to stderr, only shown with `--debug`.                                                            |
| `context.log.info(msg)`   | Print to stderr.                                                                                       |
| `context.log.warn(msg)`   | Print to stderr with a `[warn]` prefix.                                                                |
| `context.log.error(msg)`  | Print to stderr with an `[error]` prefix.                                                              |
| `context.setSecret(n, v)` | Register a secret. Subsequent steps see it as `${{ secrets.<n> }}`, and the value is masked in output. |
| `context.setEnv(n, v)`    | Register an env var visible to later steps via `${{ env.<n> }}` and exported into their environment.   |

`setSecret` and `setEnv` accept strings only. The first call to `setSecret` for a given name wins — later calls with the
same name are no-ops and emit a warning. Env vars from `setEnv` are layered like a workflow-level `env:` for steps after
the action.

## Outputs

Whatever the function returns becomes the step's outputs. Keys are strings, values can be any JSON-serialisable shape,
but the most ergonomic and consistent values for downstream `${{ }}` use are strings, numbers, and booleans.

```js
return { tag: 'v1.2.3', commits: 14, dirty: false };
```

```yml
- id: build
  uses: ./scripts/build.action
- env:
    TAG: ${{ steps.build.outputs.tag }}
    COMMITS: ${{ steps.build.outputs.commits }}
  run: echo "$TAG ($COMMITS commits)"
```

If the function returns `undefined` or a non-object, the step has no outputs. Returning an array is treated the same as
returning nothing.

## Errors and exit codes

Throw to fail the step. The runner prints the full stack trace and exits non-zero, which fails the task (after retries
are exhausted).

```js
if (!inputs.bucket) throw new Error('bucket is required');
```

In Python, raise any exception:

```py
if not inputs.get("bucket"):
    raise ValueError("bucket is required")
```

There is no `continue-on-error` — handle expected error cases inside the action and either return a structured result or
throw.

## Environment

Actions — and shell and docker steps too — inherit a _minimal_ environment, not the full developer shell. The env
each step sees comes from:

- The workflow / task / step `env:` blocks visible to the step.
- Anything previously registered via `context.setEnv`.
- `-e KEY[=VALUE]` and `--env-file` flags supplied to the `zorb run` invocation. Use `-e KEY` (no value) to forward
  a value from your current shell.

That intentionally excludes the wide world of shell-exported variables your terminal happens to have. If a step
needs something — including `PATH`-resident binaries an unusual install requires, or a credential like
`GITHUB_TOKEN` — the workflow has to declare it or the caller has to pass it explicitly. This sandboxing applies to
shell, docker, and action steps alike, so an untrusted action can't read `process.env.AWS_SECRET_ACCESS_KEY` or
similar.

## Local actions vs. NPM actions

Resolution is the same for both:

- `uses: ./relative/path.action` — file on disk, resolved against the workflow's directory. The runtime extension is
  detected on disk; don't write it into `uses:`.
- `uses: @scope/package/path` — resolved via `node_modules` relative to the workflow. The package is expected to expose
  a file at the requested subpath; e.g. `@zorb/aws/s3/sync` looks for `node_modules/@zorb/aws/s3/sync.{js,mjs,…}`.

For NPM actions, install the package the usual way (`npm install @zorb/aws`). Missing `@zorb/*` packages produce an
install hint.

## Calling another workflow task

Tasks in other zorb files can be invoked through the same `uses:` mechanism, but they're not actions — they're called
through the workflow runner instead:

- `uses: ./zorb.build` — task `build` in the current file.
- `uses: ./infra/zorb.deploy` — task `deploy` in `./infra/zorb.yml`.

Cross-file tasks only see the inputs you pass via `with:`; the parent's inputs are not inherited. Cycles error.

## Testing actions

Two paths, both useful:

**1. Unit-test the function** directly.

```ts
// scripts/version.action.test.ts
import { test, expect } from 'bun:test';
import { action } from './version.action.ts';

const ctx = {
  cwd: process.cwd(),
  taskName: 'test',
  log: { debug() {}, info() {}, warn() {}, error() {} },
  setSecret() {},
  setEnv() {},
};

test('reads package.json version', () => {
  const out = action({}, ctx);
  expect(out.version).toMatch(/^\d+\.\d+\.\d+$/);
});
```

**2. Run it through zorb** with `zorb use`:

```sh
zorb use ./scripts/version.action.ts --with path=./package.json
```

`zorb use` invokes the action directly, no `zorb.yml` required. Step outputs are printed on completion so you can verify
the result.
