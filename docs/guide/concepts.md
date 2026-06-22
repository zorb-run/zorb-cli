# How zorb works

A short tour of the model behind zorb. Read this once and the rest of the docs will hang together.

For the field-by-field syntax, see [Workflow format](../reference/workflow.md). For the CLI surface, see
[CLI reference](../reference/cli.md). This page is the conceptual scaffolding.

## The four nouns

zorb has four things, and only four. Everything else is a property of one of them.

```
Workflow ──► Tasks ──► Steps ──► (Shell command | Action)
```

- **Workflow** — a single `zorb.yml` file. Holds tasks and any cross-cutting config (env, defaults, pre-task secret
  loaders).
- **Task** — a named, callable unit (`build`, `deploy`, `test`). What you run from the CLI.
- **Step** — one ordered unit of work inside a task. Either a shell command (`run:`) or an action invocation
  (`uses:`), never both.
- **Action** — a code file (JavaScript, TypeScript, Python) called by a `uses:` step. Takes typed inputs, returns
  structured outputs.

A workflow can have many tasks; a task can have many steps; a step is exactly one thing. There is no `parallel:`, no
`needs:`, no DAG. Steps run top-to-bottom and a non-zero exit fails the task.

## The runtime, step by step

When you run `zorb run <task>`, zorb:

1. **Discovers `zorb.yml`** — searches the current directory and walks up, the same way `git` finds `.git`. The first
   match wins and becomes the workflow's working directory. `zorb.yaml` is accepted alongside `zorb.yml`; if both
   exist in the same directory, `zorb.yml` is used and a warning names the duplicate.
2. **Parses and validates** — strictly. Unknown keys, wrong types, duplicate step IDs all error before any step runs.
3. **Resolves inputs** — types `--with` pairs against the task's declared `inputs:` and applies defaults for the rest.
4. **Loads secrets** — runs any pre-task `secrets:` actions to populate the run-scoped secret table.
5. **Runs steps in order** — each step's subprocess inherits a freshly-built env, runs to completion (or hits its
   `timeout:`), and exits.
6. **Threads outputs forward** — a step's outputs become available via `${{ steps.<id>.outputs.<key> }}` in every
   following step in the same task.
7. **Exits** with 0 on success, the step's exit code on failure, 130 on `SIGINT`, 143 on `SIGTERM`.

Each step is a fresh subprocess. There's no shared mutable state between steps other than what an action explicitly
puts into outputs, `setEnv`, or `setSecret`.

## Three kinds of step

Every step is one of:

```yml
# Shell — passes a string to $SHELL -c.
- run: npm test

# Action — invokes a code file as a subprocess.
- uses: ./scripts/version.action
  with:
    path: ./package.json

# Cross-file task — calls another zorb task by reference.
- uses: ./ops/zorb.deploy
  with:
    environment: production
```

The distinction matters because each kind has its own subprocess model, output mechanism, and resolution rules — but
all three share the same set of common fields (`name`, `id`, `env`, `timeout`, `retries`, `backoff`).

::: tip
A shell step gets `docker:` to run inside a container. It's still a shell step — just one whose subprocess happens to
be `docker run` instead of `$SHELL -c`.
:::

## How `uses:` resolves

`uses:` accepts three forms, in this resolution order:

1. **Cross-file workflow ref** — the basename starts with `zorb.`, e.g. `./zorb.build` or `./ops/zorb.deploy`.
   Resolves to a task in the indicated `zorb.yml`. The callee only sees inputs you pass via `with:`.
2. **Local action** — `./relative/path.action`. The runtime extension is detected from disk (`.ts → .mjs → .cjs → .js
   → .py`, first match wins). Writing the extension into `uses:` is an error.
3. **NPM action** — `@scope/package/path` or `package/path`. Resolved via `node_modules` relative to the workflow.

The same resolver powers `zorb use <action>` from the command line, so anything you can write in `uses:` works there
too.

## Env, layered

Env is the single trickiest concept in zorb, and the one place where the model rewards reading carefully.

**Step subprocesses never inherit `process.env`.** A shell, docker, or action step sees only the env vars that flow
through the workflow's declarative env stack. This is deliberate: it stops a workflow (or an action that workflow
consumes) from scraping credentials out of the developer's shell.

The stack, lowest to highest precedence:

```
inline CLI env  <  defaults.run.env  <  workflow env  <  task env  <  step env
```

`defaults.run.env` only applies to shell steps (not actions). Everything else applies to all step types.

The **inline CLI env** is the only path from outside the workflow file into a step. It's built from:

- `--env-file <path>` — read the file, populate the layer.
- `-e KEY=VALUE` — set inline (overrides `--env-file`).
- `-e KEY` (no value) — copy `process.env[KEY]` into the inline layer. If `KEY` isn't set in the calling shell, the
  flag is silently skipped.

So `zorb run release -e GITHUB_TOKEN` is how you say "forward whatever `GITHUB_TOKEN` happens to be in my shell." If
you don't say it explicitly, no shell-export reaches the step.

## Expressions

`${{ … }}` is zorb's template syntax. It resolves to a value just before a step runs. Four namespaces are available:

- `inputs.<name>` — task inputs from `--with`.
- `env.<name>` — env vars in scope at the point of evaluation.
- `secrets.<name>` — values from the run-scoped secret table.
- `steps.<id>.outputs.<key>` — outputs from earlier steps in the same task.

Expressions are valid in `env:` values (at every scope) and in `with:` blocks on `uses:` steps. They are **not**
expanded inside `run:` strings — those are passed to the shell verbatim. To pull an expression into a shell command,
declare it as an env var and read it natively (`$TAG` instead of `${{ steps.x.outputs.tag }}`).

This separation keeps shell scripts readable and avoids two layers of substitution biting you at unexpected times.

See [Expressions](../reference/expressions.md) for the operator, function, and filter surface.

## Outputs

Each step can produce structured outputs that later steps in the same task can read.

```yml
- id: version
  run: |
    echo "tag=v$(jq -r .version package.json)" >> "$ZORB_OUTPUT"
    echo "sha=$(git rev-parse --short HEAD)"   >> "$ZORB_OUTPUT"
- name: Tag
  env:
    TAG: ${{ steps.version.outputs.tag }}
    SHA: ${{ steps.version.outputs.sha }}
  run: git tag "$TAG" -m "Release $TAG ($SHA)"
```

- **Shell and docker steps** write `key=value` lines (or heredoc-delimited multi-line values) to `$ZORB_OUTPUT`, a
  temp file path zorb sets in the step's env.
- **Actions** return an object. The keys become outputs.

Outputs are referenced via `${{ steps.<id>.outputs.<key> }}` in `with:` and `env:`. To consume one inside a `run:`
script, map it to an env var first.

## Secrets

Secrets are values that should be masked in step output. zorb has a small, deliberate model:

1. A `secrets:` block at the top of the workflow lists actions that load credentials before any task runs. The action
   calls `context.setSecret(name, value)` for each one; zorb adds the value to a run-scoped table.
2. Inside a task, you reference the value via `${{ secrets.<name> }}` in `env:` or `with:`.
3. Any exact-substring match of a registered secret in step stdout/stderr is replaced with `***` before printing.

The whole secrets surface is built on top of actions. There's no special syntax for "this is a secret" — just call
`setSecret`. A loader like `@zorb/secrets/load-1password` or `@zorb/secrets/load-dotenv` does the actual fetching.

## What zorb is not

A short list of things people reach for that aren't here, and won't be:

- **Conditional step logic** — no `if:` expressions, no `continue-on-error`. Put branching inside the script if you
  need it.
- **Parallel steps** — steps in a task run sequentially. If you need parallel work, run multiple zorb invocations.
- **Task DAGs / `needs:`** — composition is call-style only. Use `uses: ./zorb.<task>` as a step.
- **Multiple tasks per invocation** — `zorb run a b c` isn't a thing. One task per run.
- **Event triggers** — zorb is local. There's no `on: push`. Triggers belong in whatever CI system shells out to
  `zorb run`.
- **Windows** — not yet. Shell defaults, Docker path mapping, and runner detection assume POSIX.

If you're reaching for one of these, either nest the logic inside an action (which is just code) or compose calls
from the outside.

## Next steps

- **[Creating workflows](./creating-workflows.md)** — turn the model into a `zorb.yml`.
- **[Creating shell steps](./creating-shell-steps.md)** — everything `run:` can do.
- **[Creating code steps](./creating-code-steps.md)** — invoking actions and other workflows.
- **[Writing actions](./actions.md)** — author the code on the other side of `uses:`.
- **[CLI reference](../reference/cli.md)** — every command and flag.
