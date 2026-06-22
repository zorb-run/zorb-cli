# Workflow format

A workflow is a YAML file — `zorb.yml` by default — that declares a set of tasks. This page is the reference for every
key zorb understands.

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/zorb-run/zorb-cli/main/zorb.schema.json

version: 1

defaults:
  run:
    shell: /bin/bash

env:
  PROJECT: my-app

tasks:
  build:
    description: Build the project
    steps:
      - run: npm run build
```

The schema header at the top is optional but recommended — it gives editors like VS Code autocomplete and validation.

## File discovery

`zorb` searches for `zorb.yml` starting in the current directory and walking up to each parent (the same way `git` finds
`.git`). The first match wins and becomes the workflow's working directory for relative paths.

Override the search with `--file`:

```sh
zorb --file path/to/zorb.yml list
```

## Top-level keys

| Key        | Type     | Required | Description                                                                               |
| ---------- | -------- | -------- | ----------------------------------------------------------------------------------------- |
| `version`  | integer  |          | Workflow schema version. Defaults to `1`. Currently only `1` is valid.                    |
| `defaults` | mapping  |          | Fallback values for step execution. See [Defaults](#defaults).                            |
| `env`      | mapping  |          | Environment variables visible to every task and step. See [Env](#env).                    |
| `secrets`  | sequence |          | Action invocations run once before any task to register secrets. See [Secrets](#secrets). |
| `tasks`    | mapping  | ✓        | Named tasks the workflow can execute. See [Tasks](#tasks).                                |

Unknown top-level keys are a validation error. The parser will suggest the closest known key when it spots a likely
typo.

## Tasks

A task is a named sequence of steps. Tasks live under `tasks:` and are identified by their key.

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

| Key           | Type     | Description                                                    |
| ------------- | -------- | -------------------------------------------------------------- |
| `description` | string   | Shown in `zorb list` output.                                   |
| `inputs`      | mapping  | Declared inputs. See [Inputs](#inputs).                        |
| `env`         | mapping  | Env vars added to this task on top of the workflow `env:`.     |
| `defaults`    | mapping  | Task-scoped defaults that override workflow-level `defaults:`. |
| `steps`       | sequence | The steps to execute. Required.                                |

Run a task with:

```sh
zorb run build
zorb run build --with target=staging
```

## Inputs

Inputs are typed task parameters passed in via a single `--with key=value [key=value...]` flag on the CLI (one
`--with`, one or more space-separated pairs). They mirror GitHub Actions' `inputs:` shape.

```yml
tasks:
  deploy:
    inputs:
      environment:
        description: Target environment
        type: string
        required: true
      dry-run:
        description: Print the plan without applying it
        type: boolean
        default: false
      replicas:
        type: number
        default: 1
```

| Key           | Type    | Description                                                           |
| ------------- | ------- | --------------------------------------------------------------------- |
| `description` | string  | Shown in `zorb list` and `zorb help`.                                 |
| `type`        | string  | One of `string`, `number`, `boolean`. Defaults to `string`.           |
| `required`    | boolean | Error if the caller omits this input. Defaults to `false`.            |
| `default`     | any     | Value used when the input is omitted. Must match the declared `type`. |

CLI coercion: `boolean` accepts `true`, `false`, `yes`, `no`, `1`, `0`. `number` accepts any value parseable as a float.
Passing a `--with` key that isn't declared in `inputs:` prints a warning. Inputs are accessed in expressions via
`${{ inputs.<name> }}` — see [Expressions](./expressions.md#inputs-name).

## Steps

Every step is either a **shell step** (`run:`) or an **action step** (`uses:`). A step cannot have both.

Common fields:

| Key       | Type     | Description                                                                                              |
| --------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `name`    | string   | Display name shown in the step header. Optional.                                                         |
| `id`      | string   | Identifier used by later steps to read this step's outputs. Optional. See [Step outputs](#step-outputs). |
| `env`     | mapping  | Env vars added on top of the task's `env:`, scoped to this step only.                                    |
| `timeout` | duration | Fail the step if it runs longer than this. Format: a single number + unit — `500ms`, `30s`, `5m`, `1.5h`. |
| `retries` | integer  | Number of additional attempts after the first. `retries: 2` means up to three attempts total.            |
| `backoff` | string   | Delay strategy between retries. `linear` (1s, 2s, 3s, …) or `exponential` (1s, 2s, 4s, …).               |

### Shell steps (`run:`)

`run:` executes a command via `$SHELL -c`. Multi-line YAML strings are passed as a single script.

```yml
- name: Build and test
  run: |
    npm ci
    npm test
    npm run build
```

| Key      | Type           | Description                                                                                                            |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `run`    | string         | The shell command(s) to execute. Required.                                                                             |
| `shell`  | string         | Override the shell for this step (e.g. `/bin/sh`).                                                                     |
| `cwd`    | string         | Working directory, resolved relative to the workflow file. Defaults to `defaults.run.cwd` or the workflow's directory. |
| `docker` | string/mapping | Run the command inside a container. See [Docker steps](#docker-steps).                                                 |

The string passed to `run:` is **not** interpolated by zorb. `${{ }}` expressions are valid only in `env:` and `with:`.
To pass dynamic values into a shell command, declare them in `env:` and read them as native shell variables.

stdin, stdout, and stderr are inherited from the running terminal — interactive prompts work as expected. A non-zero
exit code fails the task (after retries are exhausted).

### Docker steps

A `run:` step gets containerised by adding `docker:`. Two shapes:

```yml
- name: Quick check
  docker: postgres:16
  run: pg_isready -h db

- name: Sandboxed build
  docker:
    image: node:20-alpine
    volumes:
      - ./src:/app/src
    workdir: /app
    network: host
    platform: linux/amd64
    entrypoint: /bin/sh
    pull: if-not-present
  run: npm ci && npm run build
```

| Key          | Type     | Description                                                           |
| ------------ | -------- | --------------------------------------------------------------------- |
| `image`      | string   | Image reference. Required.                                            |
| `volumes`    | string[] | `host:container` mount specs. No paths are mounted unless declared.   |
| `network`    | string   | Docker network mode (e.g. `host`).                                    |
| `workdir`    | string   | Working directory inside the container.                               |
| `platform`   | string   | Target platform (`linux/amd64`, `linux/arm64`).                       |
| `entrypoint` | string   | Override the image entrypoint.                                        |
| `pull`       | string   | `always`, `never`, or `if-not-present`. Defaults to `if-not-present`. |

zorb does not auto-mount the host filesystem. The container starts isolated; you opt into the source tree via
`volumes:`. The `$ZORB_OUTPUT` file is the one exception — it's mounted into the container automatically so step outputs
work.

### Action steps (`uses:`)

`uses:` invokes a code action — a local file, an NPM package, or a task in another workflow file.

```yml
- name: Build the docs
  uses: ./scripts/build-docs.action
  with:
    flags: --strict
```

| Key    | Type    | Description                                                                                                                                   |
| ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `uses` | string  | Reference to resolve. See [Resolution](#uses-resolution). Required.                                                                           |
| `with` | mapping | Key-value inputs passed to the action. Values support `${{ }}` expressions. Reserved keys (matching declared inputs) are type-checked.        |
| `bin`  | string  | Override the runtime launch template for this step. `{0}` is substituted with the runner script path. Defaults to `bun {0}` or `python3 {0}`. |

Actions are invoked as a subprocess and exchange JSON over temporary files. The contract for action authors is
documented in [Writing actions](../guide/actions.md).

### Resolution

`uses:` resolves in this order:

1. **Workflow task reference** — if the basename starts with `zorb.` (e.g. `./zorb.build`, `./other/zorb.deploy`), it
   resolves to a task in the indicated `zorb.yml`. Cross-file references work the same as in-file ones, except the
   referenced task only sees the inputs supplied via `with:`. Cycles are detected and error.
2. **Local file** — `./path/to/file.action` resolves to the file with one of the supported extensions, tried in order:
   `.ts`, `.mjs`, `.cjs`, `.js`, `.py`. The `uses:` value itself must not include the runtime extension — write
   `./path/to/file.action`, not `./path/to/file.action.ts`; zorb detects the runtime from the file on disk. If more
   than one extension matches the same path, the first one wins and zorb prints a warning listing the alternatives.
   The file is loaded by the matching runner.
3. **NPM package** — `@scope/package/path` (e.g. `@zorb/aws/s3/sync`) resolves via `node_modules` relative to the
   workflow's directory. Missing `@zorb/*` packages error with an install hint.

## Step outputs

Steps can produce outputs that later steps in the same task can read.

```yml
tasks:
  release:
    steps:
      - id: version
        uses: ./scripts/version.action
      - name: Tag
        env:
          TAG: ${{ steps.version.outputs.tag }}
        run: git tag "$TAG"
```

- Code actions return an object — the keys become outputs.
- Shell steps write `key=value` lines (or heredoc-delimited multi-line values) to the file path in `$ZORB_OUTPUT`.
- Outputs are referenced via `${{ steps.<id>.outputs.<key> }}` in `with:` and `env:`. To use one inside a `run:` string,
  map it to an env var.

Duplicate step IDs within the same task are a validation error.

## Env

::: warning Strict, declaration-only environment
Step subprocesses — shell, docker, **and** action — never inherit `process.env` from the `zorb` process. The only env
vars that reach a step are those declared in workflow / task / step `env:` blocks, or supplied via `--env-file` /
`-e/--env` on the CLI. This is deliberate: it prevents a workflow (or an action a workflow consumes) from scraping
secrets out of the developer's shell. Anything a step depends on must be visible in the workflow or at the call site.
:::

Layers, lowest to highest precedence:

```
inline CLI env  <  defaults.run.env  <  workflow env  <  task env  <  step env
```

(`defaults.run.env` applies to `run:` steps only; action steps skip it.)

Workflow-level `env:` is visible inside task-level `env:` expressions (via `env.<name>`), so you can compose values:

```yml
env:
  BASE_URL: https://example.com

tasks:
  ping:
    env:
      HEALTH_URL: ${{ env.BASE_URL }}/health
```

CLI flags feed into the inline layer:

- `--env-file <path>` — load variables from a `.env`-formatted file.
- `-e KEY=VALUE` / `--env KEY=VALUE` — set inline; repeatable; overrides `--env-file`.
- `-e KEY` (no value) — explicit pass-through: copy `process.env[KEY]` into the inline layer. If `KEY` isn't set in
  the calling environment, the flag is silently skipped. This is the supported way to forward a credential like
  `GITHUB_TOKEN` from your shell into a step.

## Defaults

`defaults:` provides fall-back values for shell steps at the workflow and task scope. Task defaults override workflow
defaults; an explicit value on the step itself wins over both.

```yml
defaults:
  run:
    shell: /bin/bash
    cwd: ./scripts
    env:
      LOG_LEVEL: info

tasks:
  test:
    defaults:
      run:
        cwd: ./test
    steps:
      - run: bun test
```

| Key                      | Type    | Description                                                                |
| ------------------------ | ------- | -------------------------------------------------------------------------- |
| `defaults.run.shell`     | string  | Default shell for `run:` steps. Defaults to `$SHELL`.                      |
| `defaults.run.cwd`       | string  | Default working directory for `run:` steps.                                |
| `defaults.run.env`       | mapping | Default env vars — overridden by `env:` at higher scopes.                  |
| `defaults.action.js.bin` | string  | Bin template for `.js`/`.cjs`/`.mjs`/`.ts` actions. Defaults to `bun {0}`. |
| `defaults.action.py.bin` | string  | Bin template for `.py` actions. Defaults to `python3 {0}`.                 |

`defaults.run.*` applies only to shell steps; `defaults.action.*` only to action steps.

## Secrets

The top-level `secrets:` block runs a list of action invocations before any task starts. It's reserved for actions that
register secret values into the run-scoped table.

```yml
secrets:
  - uses: '@zorb/secrets/load-1password'
    with:
      vault: Production
      items: [DATABASE_URL, STRIPE_API_KEY]
  - uses: '@zorb/secrets/load-dotenv'
    with:
      path: .env.production

tasks:
  deploy:
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
    steps:
      - run: ./bin/migrate
```

Each entry has the same shape as an action step but cannot use `run:` or `docker:`. Registered values are masked in step
stdout/stderr — any exact-substring match is replaced with `***` before printing.

Secrets can also be loaded inside a task by adding a regular `uses:` step. Task-scoped loaders apply only to that task.

## Out of scope

These features come up regularly but are explicit non-goals for now:

- **Conditional logic** — no `if:` expressions or `continue-on-error`.
- **Parallel steps** — steps in a task run sequentially.
- **Task DAGs / `needs:`** — composition is call-style only (use `uses: ./zorb.<task>`).
- **Multiple tasks per invocation** — `zorb run a b c` isn't supported; pick one task per invocation.
- **Windows** — shell defaults, Docker path mapping, and runner detection assume POSIX for now.
