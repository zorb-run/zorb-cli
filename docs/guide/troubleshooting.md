# Troubleshooting

The gotchas that bite first, with the fix for each. If something here doesn't match what you're seeing,
[open an issue](https://github.com/zorb-run/zorb-cli/issues) — this list is short by design and we'd rather grow it
from real reports than guess.

## My env var isn't visible inside the step

**Symptom:** A step echoes an empty string for `$GITHUB_TOKEN`, `$AWS_PROFILE`, or another variable that's set in your
shell.

**Cause:** Step subprocesses **never** inherit `process.env`. zorb deliberately sandboxes shell, docker, and action
steps to a declaration-only env. Anything your step needs has to be visible in the workflow's `env:` blocks or passed
through explicitly.

**Fix:** Pick one of the supported channels:

```sh
# Forward the current shell's value
zorb run release -e GITHUB_TOKEN

# Set inline at the CLI
zorb run release -e GITHUB_TOKEN=ghp_xxx

# Load from a file
zorb run release --env-file .env.release
```

Or declare it in the workflow:

```yml
env:
  GITHUB_TOKEN: ${{ env.GITHUB_TOKEN }}  # only works if it's already in scope at workflow load
```

The exception that catches people: workflow-level `env:` blocks themselves are evaluated against the same inline env
layer, so referencing `${{ env.GITHUB_TOKEN }}` there still requires you to pass it via `-e` or `--env-file`.

See [Concepts → Env, layered](./concepts.md#env-layered) for the full model.

## `${{ … }}` shows up literally in my shell command

**Symptom:** A `run:` step like `run: echo "${{ inputs.environment }}"` prints `${{ inputs.environment }}` instead of
the value.

**Cause:** `${{ }}` expressions are not interpolated inside `run:` strings. The whole string is handed to the shell
verbatim.

**Fix:** Map the expression to an env var first, then read the env var natively:

```yml
- env:
    TARGET: ${{ inputs.environment }}
  run: echo "$TARGET"
```

This avoids two layers of substitution and keeps shell quoting predictable. See
[Expressions → Where expressions work](../reference/expressions.md#where-expressions-work).

## "multiple files match" warning when running a task

**Symptom:**

```
warning: multiple files match './scripts/greet.action' — using …/greet.action.ts (also found: …/greet.action.js)
```

**Cause:** zorb's `uses:` resolver tries each known runtime extension in order (`.ts → .mjs → .cjs → .js → .py`) and
warns when more than one matches the same logical path. You probably have a stale file sitting next to a newer one.

**Fix:** Delete the stale file (or rename it). The first match wins, so the warning is harmless — it just makes the
ambiguity visible. Keep the version you mean to run.

## "uses: value includes a runtime extension"

**Symptom:**

```
error: 'uses:' value './scripts/greet.action.ts' includes a runtime extension
  hint: drop the '.ts' suffix — zorb detects the runtime from the file on disk
```

**Cause:** zorb wants the source of truth for "which runtime?" to live on disk, not in every `uses:` value that calls
the action. Writing the extension would mean renaming `.js → .ts` ripples through every workflow that references the
file.

**Fix:** Drop the extension. `uses: ./scripts/greet.action` resolves to whichever extension exists on disk.

## My task can't find another task in the same file

**Symptom:**

```
error: could not resolve action './zorb.build'
```

…even though `build` exists in the same `zorb.yml`.

**Cause:** Cross-file workflow refs use the `zorb.<task>` basename. Same-file refs look identical (`./zorb.build`) and
go through the same machinery — zorb tries to open a `zorb.yml` next to the workflow. If the workflow file is named
something other than `zorb.yml` (e.g. you passed `--file ops/build.yml`), the directory still has to contain a
`zorb.yml` for the ref to work.

**Fix:** Either rename the file to `zorb.yml`, or split the tasks across files so each lives in a directory named
appropriately.

## My secret isn't masked in the output

**Symptom:** A secret value appears in step stdout/stderr as plain text.

**Cause:** zorb masks only exact-substring matches of values registered via `context.setSecret(name, value)`. Two
common reasons a value isn't masked:

1. It was set via `setEnv`, not `setSecret`. `setEnv` doesn't add to the secret table.
2. The value in the output is a transformed version of the secret — base64-encoded, truncated, etc.

**Fix:** Always use `setSecret` for credentials, and avoid transformations in step output that would prevent the
substring match. If you need to log a derived value (e.g. a token's expiry), log the metadata, not the value.

## My action ran but produced no outputs

**Symptom:** A later step reading `${{ steps.x.outputs.foo }}` errors with "undefined step output".

**Cause:** One of:

- The action returned `undefined`, a primitive, or an array. Only objects are treated as outputs.
- The action threw, the run was retried, and the eventual successful attempt returned different keys.
- The step doesn't have an `id:` set — outputs are only addressable when a step has one.

**Fix:** Return a plain object with string keys. Give the step an `id:`. If a later step needs an output, the producing
step needs an explicit `id:` for the reference to compile.

## A shell step succeeds even though one command in it failed

**Symptom:** A multi-line `run:` block exits 0 even though something in the middle failed.

**Cause:** zorb checks the shell's exit code, which is the **last command's** exit code by default. A failure halfway
through a script doesn't propagate unless you tell the shell to abort.

**Fix:** Start the block with `set -euo pipefail` (or your shell's equivalent):

```yml
- run: |
    set -euo pipefail
    npm ci
    npm test
    npm run build
```

`-e` aborts on the first non-zero exit, `-u` aborts on unset variable expansion, `-o pipefail` makes a pipeline fail
when any stage fails, not just the last one.

## Watch mode rebuilds in an endless loop

**Symptom:** `zorb run … --watch` keeps re-running. The task itself creates files that the watcher then sees as
changes.

**Cause:** `fs.watch` is recursive over the workflow directory; if the task writes into that tree, the writes match
the glob and trigger another rerun.

**Fix:** Tighten the glob so it only matches sources, not build artefacts:

```sh
# Bad — matches anything under the workflow dir
zorb run build --watch '**/*'

# Good — matches only source
zorb run build --watch 'src/**/*.{ts,tsx}'
```

Output directories (`dist/`, `build/`, `.next/`) shouldn't appear in the glob.

## Colour codes leak into a file when I redirect output

**Symptom:** `zorb run build > log.txt` produces a file full of `\x1b[…m` ANSI sequences.

**Cause:** `FORCE_COLOR` is set somewhere in your environment (Bun and other tools sometimes export it), and zorb
honours it even when stdout isn't a TTY.

**Fix:** Either unset `FORCE_COLOR` for the run, or pass `--no-color`:

```sh
zorb --no-color run build > log.txt
FORCE_COLOR= zorb run build > log.txt
```

`--no-color` wins over `FORCE_COLOR`. `NO_COLOR=1` works too.

## My input default isn't being applied

**Symptom:** An input declared with a `default:` shows up as undefined inside an expression.

**Cause:** Two possibilities:

- The input wasn't declared on the **task** you're running — declarations are per-task, not workflow-wide.
- You're referencing an input that exists but with a typo (`inputs.envronment`). zorb errors on undefined references
  rather than silently falling back to an empty string.

**Fix:** Check the spelling and that the input is declared on the running task. The error from zorb names the
namespace, so `undefined variable: inputs.envronment` is the strongest hint there is.

## `zorb` exits 130 / 143 when I expected 1

**Symptom:** A failing task exits with 130 or 143 instead of the script's exit code.

**Cause:** These are signal exit codes — 130 is `SIGINT` (often Ctrl-C, or a parent process forwarding it), 143 is
`SIGTERM` (usually a supervisor). zorb maps signals to 128 + signal number, by convention.

**Fix:** If you're running zorb inside a wrapper, make sure the wrapper isn't sending signals to zorb's process group
on its own. If you're seeing 130 interactively without pressing Ctrl-C, look for terminals or watchers that propagate
signals to child processes.

## More help

- **[CLI reference](../reference/cli.md)** — every flag with its exact behaviour.
- **[Workflow format](../reference/workflow.md)** — the precise validation rules.
- **[Expressions](../reference/expressions.md)** — the full `${{ … }}` surface.
- **[GitHub issues](https://github.com/zorb-run/zorb-cli/issues)** — for things this page doesn't cover.
