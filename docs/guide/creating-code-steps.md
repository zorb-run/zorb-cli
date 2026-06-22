# Creating code steps

A code step replaces shell scripting with a real function — JavaScript, TypeScript, or Python — that takes typed inputs,
talks to zorb via a `context` object, and returns structured outputs. This guide covers the workflow-side picture: how
to reference an action, pass inputs in, read outputs out, and decide when a code step is the right tool.

For the function-authoring side — the `action(inputs, context)` contract, the `context` API, how to test — see
[Writing actions](./actions.md).

## The shape of a code step

A code step is any step with a `uses:` field. The value resolves to a file on disk, an NPM package, or another workflow
task.

```yml
tasks:
  release:
    steps:
      - id: version
        uses: ./scripts/version.action
      - name: Publish
        env:
          TAG: ${{ steps.version.outputs.tag }}
        with:
          channel: stable
        run: npm publish --tag "$TAG"
```

A step can have `run:` or `uses:`, not both. The fields specific to code steps are:

| Field   | Purpose                                                                                  |
| ------- | ---------------------------------------------------------------------------------------- |
| `uses:` | The action to invoke. Local file, NPM package, or workflow task reference.               |
| `with:` | Inputs passed to the action's `action(inputs, …)` function. Supports `${{ }}`.           |
| `bin:`  | Override the launcher template (e.g. `node {0}` instead of `bun {0}`). Rarely needed.    |

Common step fields (`name`, `id`, `env`, `timeout`, `retries`, `backoff`) work for code steps too.

## Local file actions

The most common form: point `uses:` at a file relative to the workflow.

```yml
- uses: ./scripts/greet.action
  with:
    name: world
```

The `uses:` value never includes the runtime extension — `./scripts/greet.action` resolves to the file on disk
regardless of whether it's TypeScript, JavaScript, or Python. zorb detects the runtime by trying each supported
extension in order:

```
.ts → .mjs → .cjs → .js → .py
```

The first match wins. If more than one extension matches the same path — say you have both `greet.action.ts` and
`greet.action.js` sitting next to each other — zorb prints a warning so the ambiguity is visible:

```
warning: multiple files match './scripts/greet.action' — using …/greet.action.ts (also found: …/greet.action.js)
```

Delete the stale file (or rename one of them) to clear the warning. Writing the runtime extension into `uses:`
directly — `./scripts/greet.action.ts` — is an error: zorb wants the source of truth for "which runtime?" to live on
disk, so renaming `.js` → `.ts` doesn't ripple through every workflow that calls it.

::: tip
The `.action` segment is a naming convention, not a magic suffix. `./scripts/greet` works exactly as well as
`./scripts/greet.action` — pick whichever reads better in your tree.
:::

## NPM-package actions

`uses:` strings without a leading `./` or `../` resolve as NPM packages. zorb walks up the workflow's directory tree
looking for `node_modules/<package>`, just like Node does:

```yml
- uses: '@zorb/aws/s3/sync'
  with:
    bucket: my-bucket
    source: ./dist
```

The subpath after the package name maps to whatever the package's `exports` (or file layout) exposes — e.g.
`@zorb/aws/s3/sync` looks for `node_modules/@zorb/aws/s3/sync.{ts,mjs,cjs,js,py}`. Install packages the usual way
(`npm install @zorb/aws`, `bun add`, etc.). Missing `@zorb/*` packages produce an install hint with the right command.

## Passing inputs with `with:`

`with:` is a mapping of inputs the action receives as its first argument. Values support `${{ }}` expressions, so you
can wire inputs through from CLI flags, env vars, previous step outputs, or secrets:

```yml
tasks:
  notify:
    inputs:
      env-name:
        type: string
        required: true
    steps:
      - id: meta
        uses: ./scripts/git-meta.action
      - uses: '@zorb/slack/notify'
        with:
          channel: '#deploys'
          message: 'Deployed ${{ inputs.env-name }} from ${{ steps.meta.outputs.sha }}'
          token: ${{ secrets.SLACK_TOKEN }}
```

Inputs keep their JSON types — strings stay strings, numbers stay numbers, booleans stay booleans, arrays stay arrays.
The action receives them as a plain object (Python: a `dict`).

## Reading outputs

A code step's return value becomes its outputs. Give the step an `id:` and any later step in the same task can read the
outputs back via `${{ steps.<id>.outputs.<key> }}`:

```yml
- id: build
  uses: ./scripts/build.action      # returns { artifact: '…', size: 12345 }
- name: Upload
  env:
    ARTIFACT: ${{ steps.build.outputs.artifact }}
    SIZE: ${{ steps.build.outputs.size }}
  run: ./scripts/upload.sh
```

Outputs are valid in `with:` and `env:`. To consume one inside a `run:` script, map it to an env var first — `run:`
strings are never interpolated.

Step IDs must be unique within a task; duplicates are a parse-time error. A step that doesn't need to be referenced
doesn't need an `id:`.

## Side effects: secrets and env

Code steps can register values into the run for subsequent steps:

- `context.setSecret(name, value)` — adds a value that's masked in step output and readable via
  `${{ secrets.<name> }}`.
- `context.setEnv(name, value)` — adds an env var readable via `${{ env.<name> }}` and exported into later step
  environments.

This is how loader actions like `@zorb/secrets/load-1password` or `@zorb/env/load-dotenv` work. From the workflow's
perspective there's nothing special to declare — just invoke the loader and reference the values:

```yml
secrets:
  - uses: '@zorb/secrets/load-1password'
    with:
      vault: Production
      items: [DATABASE_URL]

tasks:
  migrate:
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
    steps:
      - run: ./bin/migrate
```

Secrets and env loaded inside a task scope only to that task. Loaders run before the steps that need their values, so
ordering matters.

## Cross-file workflow refs

`uses:` can also point at a task in another `zorb.yml`. zorb spots these by the `zorb.` basename:

```yml
- uses: ./zorb.build              # task `build` in this same file
- uses: ./ops/zorb.deploy         # task `deploy` in ./ops/zorb.yml
  with:
    environment: production
```

Cross-file refs are run by the workflow runner, not the code-action runner — they're closer to "function call" than
"subprocess." The callee only sees inputs you pass via `with:`; the parent's inputs do not leak in. Cycles error.

## Choosing the launcher

By default zorb runs JS/TS/MJS/CJS actions with `bun {0}` and Python with `python3 {0}`, where `{0}` is the path to the
runner script. Override per workflow, per task, or per step when you need a different runtime:

```yml
defaults:
  action:
    js:
      bin: node --experimental-strip-types {0}
    py:
      bin: /opt/venv/bin/python {0}
```

Per-step override:

```yml
- uses: ./scripts/heavy.action
  bin: bun --smol {0}
  with: { … }
```

## Run an action ad hoc

While iterating, `zorb use` runs an action directly without needing a `zorb.yml` step around it:

```sh
zorb use ./scripts/version.action --with path=./package.json
zorb use '@zorb/aws/s3/sync' --with bucket=staging source=./dist
```

`zorb use` accepts the same `--with key=value` syntax as `zorb run` (one `--with`, space-separated pairs) and prints
the action's outputs on completion. It's
the fastest way to verify an action does what you expect before you wire it into a task.

## Code step or shell step?

Reach for a code step when:

- The work is structured — JSON in, JSON out, with branching or loops.
- You want typed inputs and explicit outputs instead of stringly-typed env vars.
- The logic needs unit tests.
- The same operation is reused across multiple tasks or workflows (factor it once, call it from anywhere).

Stick with a shell step when:

- The work is a short, linear sequence of shell-native commands.
- A short pipeline expresses the intent more clearly than 20 lines of JavaScript would.

Both step types share `name`, `id`, `env`, `timeout`, `retries`, and `backoff`, so you can mix and match within a task
without friction.

## Next steps

- **[Writing actions](./actions.md)** — author the function on the other side of `uses:`.
- **[Workflow format reference](../reference/workflow.md#action-steps-uses)** — every code-step field.
- **[Expressions](../reference/expressions.md)** — the full `${{ }}` syntax for `with:` and `env:`.
