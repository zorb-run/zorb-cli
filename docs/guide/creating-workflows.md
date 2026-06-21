# Creating workflows

A workflow is a single YAML file — `zorb.yml` — that declares the tasks you can run from the command line. This guide
covers how to build one up: where the file lives, what shape it takes, and how to keep it maintainable as it grows.

For the field-by-field reference, see [Workflow format](../reference/workflow.md). This page is the narrative version.

## Start with `zorb init`

The fastest way to create a workflow is to let zorb scaffold one for you:

```sh
zorb init
```

That writes a starter `zorb.yml` in the current directory with a schema header and a single `hello` task. If a workflow
already exists, the command errors rather than overwrite it.

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/zorb-run/zorb-cli/main/zorb.schema.json

tasks:
  hello:
    description: Print a greeting
    steps:
      - run: echo "Hello, zorb!"
```

The schema header is optional but recommended — editors like VS Code use it for autocomplete and inline validation.

## Where the file lives

zorb finds `zorb.yml` by searching the current directory and walking up to each parent, the same way `git` finds `.git`.
The first match wins and becomes the workflow's "working directory" — every relative `cwd:`, file `uses:`, and
`--env-file` is resolved against it.

To use a workflow somewhere else without `cd`-ing, pass `--file`:

```sh
zorb --file ops/zorb.yml run deploy
```

::: tip
A workflow at the repo root is usually the right call. Tasks become discoverable from anywhere inside the project, and
relative paths from steps line up with what you'd type in the shell.
:::

## The top-level shape

A workflow has five top-level keys. Only `tasks:` is required.

```yml
version: 1                  # Optional — reserved for future schema bumps
defaults: { … }             # Fall-back shell, cwd, env for steps
env: { … }                  # Variables visible to every task
secrets: [ … ]              # Pre-task secret loaders
tasks: { … }                # The named tasks themselves
```

Unknown top-level keys are a validation error — the parser will suggest the closest known key when it spots a likely
typo, so `setp:` or `tassk:` won't silently no-op.

## Tasks

Each entry under `tasks:` is a named, self-contained unit of work. A task has up to five fields of its own:

```yml
tasks:
  build:
    description: Compile the project
    inputs:
      target:
        type: string
        default: production
    env:
      NODE_ENV: ${{ inputs.target }}
    defaults:
      run:
        shell: /bin/sh
    steps:
      - run: npm run build
```

- **`description:`** appears in `zorb list` output and in `zorb help build`.
- **`inputs:`** declares typed CLI parameters that callers pass with `--with`.
- **`env:`** layers on top of the workflow-level `env:` for every step in this task.
- **`defaults:`** overrides workflow-level defaults inside this task.
- **`steps:`** is the only required field — an ordered sequence of shell or code steps.

List what a workflow exposes:

```sh
$ zorb list
build — Compile the project
test  — Run the test suite
```

## Layering environment variables

`env:` cascades through three scopes. Inner scopes override outer ones, and step-level wins outright.

```yml
env:
  PROJECT: my-app

tasks:
  build:
    env:
      NODE_ENV: production
    steps:
      - run: echo "$PROJECT — $NODE_ENV"  # my-app — production

      - name: With override
        env:
          NODE_ENV: development
        run: echo "$NODE_ENV"             # development
```

You can compose values across scopes — workflow-level `env:` is available inside task-level expressions via
`${{ env.<name> }}`:

```yml
env:
  BASE_URL: https://example.com
tasks:
  ping:
    env:
      HEALTH_URL: ${{ env.BASE_URL }}/health
```

The CLI also contributes env via `--env-file <path>` and repeated `-e KEY=VALUE` flags. `-e` overrides `--env-file`,
which overrides the workflow's `env:`.

## Defaults

`defaults:` is where you put fall-back values that would be tedious to repeat on every step. It accepts both
shell-step defaults and action-step launcher overrides:

```yml
defaults:
  run:
    shell: /bin/bash      # default shell for `run:` steps
    cwd: ./scripts        # default working directory
    env:                  # default env vars, overridden by `env:` higher up
      LOG_LEVEL: info
  action:
    js:
      bin: bun {0}        # how to launch JS/TS/MJS/CJS runners (`{0}` = runner path)
    py:
      bin: python3 {0}
```

Task-level `defaults:` overrides workflow-level. A value set directly on the step wins over both.

## Pre-task secrets

The top-level `secrets:` block runs action invocations before any task starts, registering values into a run-scoped
table. The values can then be read via `${{ secrets.<name> }}` in `with:` and `env:` blocks, and any exact-substring
match in step output gets masked to `***`.

```yml
secrets:
  - uses: '@zorb/secrets/load-1password'
    with:
      vault: Production
      items: [DATABASE_URL, STRIPE_API_KEY]

tasks:
  deploy:
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
    steps:
      - run: ./bin/migrate
```

Each entry has the same shape as a code step but cannot use `run:` or `docker:`. Secrets can also be loaded inside a
task via a regular `uses:` step — that scopes the values to just that task.

## Splitting workflows across files

There's no hard cap on the number of tasks in a single `zorb.yml`, but once a workflow gets crowded, split it. Other
files use the `zorb.<task>` convention to be addressable from anywhere:

```
ops/
  zorb.yml         # tasks: { deploy, rollback, … }
zorb.yml           # tasks: { build, test, release, … }
```

From the root workflow, call into `ops/zorb.yml` as if it were a local task:

```yml
tasks:
  release:
    steps:
      - uses: ./zorb.build
      - uses: ./ops/zorb.deploy
        with:
          environment: production
```

Cross-file tasks only see the inputs you pass via `with:` — the parent's inputs do not leak in. Cycles are detected and
error. There's no `needs:` or DAG; composition is always call-style.

## Catching mistakes early

zorb validates the workflow strictly before running anything. Unknown keys, wrong types, missing required fields, and
duplicate step IDs all surface with file/line/column context and a hint where applicable:

```
zorb.yml:6:9: unknown task field 'inptus' — did you mean 'inputs'?
```

The schema header at the top of the file is the same idea applied in your editor: VS Code (and any LSP that honours
`yaml-language-server`) will autocomplete keys, flag typos, and surface the description for each field as you hover.

## Next steps

- **[Creating shell steps](./creating-shell-steps.md)** — the full picture of `run:` steps.
- **[Creating code steps](./creating-code-steps.md)** — calling actions and other workflows with `uses:`.
- **[Workflow format reference](../reference/workflow.md)** — every key, every type.
- **[Expressions](../reference/expressions.md)** — variables, operators, and filter syntax for `${{ }}`.
