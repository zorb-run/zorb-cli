# CLI reference

The complete surface of the `zorb` command — every subcommand, every flag, every behaviour you'd otherwise discover
through `--help`.

```
zorb <command> [options]
```

If you call `zorb` with no command, it prints the top-level help. Run `zorb help <command>` for the same per-command
help that follows the long-form section below.

## Commands at a glance

| Command          | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `zorb init`      | Scaffold a starter `zorb.yml` in the current directory.       |
| `zorb list`      | Print the tasks defined in `zorb.yml`.                        |
| `zorb run`       | Run a task from `zorb.yml`.                                   |
| `zorb use`       | Run an action directly, with no `zorb.yml` step around it.    |
| `zorb help`      | Print top-level or per-command help.                          |

## Global flags

These flags work with every command. They can appear before or after the subcommand.

| Flag                                | Description                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `-f`, `--file <path>`               | Use a workflow file other than the discovered `zorb.yml`.                              |
| `--env-file <path>`                 | Load env vars from a `.env`-formatted file before running.                             |
| `-e`, `--env KEY[=VALUE]`           | Set an env var inline. Repeatable. Bare `-e KEY` forwards the calling shell's value.   |
| `-v`, `--verbose`                   | Print additional progress detail to stderr.                                            |
| `--debug`                           | Print debug-level diagnostics to stderr (includes `verbose`).                          |
| `--quiet`                           | Suppress everything except error output.                                               |
| `--no-color`                        | Disable ANSI colour in stdout/stderr.                                                  |
| `--version`                         | Print the version string and exit.                                                     |
| `-h`, `--help`                      | Print help for the current command and exit.                                           |

::: warning No `--flag=value` form
Every flag uses the space-separated form (`--file path/to/zorb.yml`, `-e KEY=VALUE`). The `--flag=value` and `-x=value`
spellings are rejected outright so there's exactly one way to spell each flag.
:::

## `zorb init`

Scaffold a starter `zorb.yml` in the current directory. Errors if one already exists rather than overwrite it.

```sh
zorb init
```

The scaffold contains the editor schema header and a single `hello` task you can edit or replace. Use the global
`--file <path>` to write somewhere other than the current directory.

## `zorb list`

Print every task defined in the discovered workflow, with descriptions and any required inputs.

```sh
zorb list
zorb list --file ops/zorb.yml
```

Output:

```
zorb.yml

Tasks (3):
  build    Compile the project
  deploy   Roll the build out to an environment
      environment  (string, required)  Target environment
  test     Run the test suite
```

Required inputs are listed beneath the task they belong to; optional inputs aren't shown — use `zorb help` or read
`zorb.yml` for the full set.

## `zorb run <task>`

Execute one task by name.

```sh
zorb run <task> [options]
```

| Option                         | Description                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `--with key=value [key=value]` | Pass inputs to the task. Space-separated pairs. **Not repeatable.**          |
| `--watch <glob>`               | Re-run the task whenever a file matching the glob changes.                   |

All global flags (`--file`, `--env-file`, `-e/--env`, verbosity, `--no-color`, `--help`) also apply here.

### `--with`

`--with` takes one or more space-separated `key=value` pairs:

```sh
zorb run deploy --with environment=staging
zorb run deploy --with environment=production dry-run=true
```

Pairs are typed against the task's declared inputs:

- `boolean` accepts `true`/`false`, `yes`/`no`, `1`/`0`.
- `number` accepts any value parseable as a float.
- `string` is unchanged.

Passing a key that isn't declared in the task's `inputs:` prints a warning, then passes the raw string through as
`${{ inputs.<key> }}`. So a typo doesn't silently disappear — you see the warning, and any expression that referenced
the misspelled key still resolves to the value you supplied. Passing one `--with` flag twice is an error — bundle all
pairs after a single `--with`.

### `--watch`

`--watch` keeps zorb running, watching the workflow directory recursively and re-running the task whenever a file path
matching the glob changes. Globs use Bun.Glob syntax — `*` matches a single path segment, `**` matches across segments.

```sh
zorb run test --watch 'src/**/*.{ts,tsx}'
zorb run docs --watch 'docs/**/*.md'
```

If a change arrives while a run is in flight, the in-flight run is aborted (its subprocesses receive `SIGTERM`) and a
fresh run starts. Changes are debounced for 100ms so editor save-storms produce one rerun, not ten.

Press `Ctrl-C` to leave watch mode — `zorb` exits 0 on `SIGINT` in watch mode, 143 on `SIGTERM`.

### Env merging

Env reaches a step subprocess through a fixed layering. Lowest to highest precedence:

```
inline CLI env  <  defaults.run.env  <  workflow env  <  task env  <  step env
```

The inline CLI layer is the only path for env from outside the workflow file. It's built (in order) from:

1. `--env-file <path>` — read the file, populate the layer.
2. `-e KEY=VALUE` — set inline, overriding `--env-file` values.
3. `-e KEY` — copy `process.env[KEY]` into the layer. If `KEY` isn't set, the flag is silently skipped.

Step subprocesses **do not** inherit `process.env`. Anything a step needs from the calling shell has to be declared in
the workflow or forwarded with `-e KEY`. See [Workflow format → Env](./workflow.md#env) for the full model.

### Examples

```sh
zorb run build
zorb run deploy --with environment=staging
zorb run deploy --with environment=production dry-run=true
zorb run test -e CI=true -e LOG_LEVEL=debug
zorb run test -e CI -e GITHUB_TOKEN              # pass-through from process env
zorb run test --watch 'src/**/*.{ts,tsx}'
zorb run release --env-file .env.release
```

## `zorb use <action>`

Run an action directly, without wiring it into a step in `zorb.yml`. The action can be a local file, an NPM package,
or a cross-file workflow reference.

```sh
zorb use <action> [options]
```

| Option                         | Description                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `--with key=value [key=value]` | Inputs passed to the action.                                                           |

All global flags apply. `--file` is honoured for picking up workflow `env:` and `defaults:` — useful when you want to
run an action with the same env layering it would see inside a step, without scaffolding a temporary task.

### Action resolution

`zorb use` uses the same resolver as `uses:` in a step (see [Workflow format → Resolution](./workflow.md#resolution)):

- `./relative/path.action` — local file. Drop the runtime extension; zorb picks it from disk (`.ts`, `.mjs`, `.cjs`,
  `.js`, `.py`, first match wins).
- `@scope/package/path` — NPM package, resolved against `node_modules` from the current directory.
- `./zorb.<task>` / `./dir/zorb.<task>` — cross-file workflow task reference. `zorb use ./zorb.build` is equivalent to
  `zorb run build`.

### Examples

```sh
zorb use ./scripts/version.action --with path=./package.json
zorb use ./scripts/version.action --with path=./package.json mode=patch
zorb use @zorb/aws/s3/sync --with bucket=my-bucket -e AWS_REGION=eu-west-1
```

Step outputs are printed to stderr on completion so you can verify what the action returned.

## `zorb help [command]`

Print help text. With no argument, prints the top-level overview; with a command name, prints that command's section.

```sh
zorb help
zorb help run
zorb help use
```

Unknown command names exit 1 with a hint.

## Exit codes

| Code  | Meaning                                                                            |
| ----- | ---------------------------------------------------------------------------------- |
| `0`   | Success.                                                                           |
| `1`   | General failure — task failed, validation error, or any non-signal error.          |
| `130` | Interrupted with `SIGINT` (typically `Ctrl-C`).                                    |
| `143` | Terminated with `SIGTERM` (typically from a supervisor).                           |
| _n_   | When a step's exit code is non-zero, the task's exit code is the step's exit code. |

Signal handling: the first `SIGINT`/`SIGTERM` triggers a graceful shutdown — the in-flight step kills its subprocesses
and the run returns 130 or 143. A second signal forces an immediate exit, in case cleanup itself wedges.

## Environment variables

| Variable               | Effect                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NO_COLOR`             | If set to anything non-empty, disable ANSI colour. Same effect as `--no-color`.                                                     |
| `FORCE_COLOR`          | If set to a non-empty value other than `0`, force-enable colour even when stdout isn't a TTY. `--no-color` still wins.              |
| `SHELL`                | Default shell for `run:` steps when no `defaults.run.shell` or step-level `shell:` is set.                                          |
| `ZORB_OUTPUT`          | _Set by zorb_ inside shell/docker steps. Path to a temp file where the step writes `key=value` lines to produce step outputs.       |

Note: `process.env` is read by zorb itself for the above, but **not** forwarded into step subprocesses. Steps see only
the env vars declared in `env:` blocks or supplied via `--env-file` / `-e`.

## Env file format

`--env-file` reads a dotenv-style file:

```
# comments start with '#'
DATABASE_URL=postgres://localhost/app
LOG_LEVEL=debug              # inline comment after value

# Optional `export` prefix is accepted and ignored
export API_TOKEN=ghp_xxx

# Quoted values preserve whitespace and support \n \t \r \" \\
GREETING="hello\nworld"
LITERAL='no escape processing here'
```

Rules:

- Blank lines and `#` comments are skipped.
- Lines must be `KEY=VALUE`. An optional `export ` prefix is stripped.
- Unquoted values: trailing inline comments (` #…`) are stripped, then the value is trimmed.
- Double-quoted values: `\n`, `\r`, `\t`, `\"`, `\\` are interpreted.
- Single-quoted values are taken literally.

The CLI does not export these into its own `process.env`; they go into the inline env layer that's passed to step
subprocesses. Reading them at the CLI level (e.g. for an expression in a top-level `env:` block) works through
`${{ env.<NAME> }}` once the workflow is loaded.
