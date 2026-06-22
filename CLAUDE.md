# CLAUDE.md

Project-specific guidance for Claude Code working in this repo. Read alongside the global rules and CONTRIBUTING.md.

## What this is

`zorb` — a declarative local workflow runner. CLI written in Bun + TypeScript. Reads `zorb.yml` and runs tasks (shell
commands and code actions). Built as a single binary, distributed via NPM (`zorb`) and eventually Homebrew.

Status: early development. Milestone roadmap lives in `../PLAN.md` (one level up). The A-track (A1 → A18) builds the CLI
core.

## Dev loop

- Run the CLI directly: `bun src/cli.ts <args>` — there's no built binary yet.
- Tests: `bun run test:unit` (unit + subprocess + binary smoke) and `bun run test:integration` (shell scripts driving
  the compiled binary).
- Typecheck: `bun run typecheck`.
- Format: `bun run format`.

Always run typecheck + tests before committing.

## Where things live

```
src/
  cli.ts            # arg parsing + command dispatch
  colors.ts         # ANSI helper (NO_COLOR / FORCE_COLOR / --no-color)
  config.ts         # workflow finder + parser + strict validator
  envfile.ts        # dotenv-style parser for --env-file
  help.ts           # top-level + per-command help strings
  logger.ts         # verbosity-aware logger (writes stdout/stderr directly)
  types.ts          # workflow shape types (Workflow, Task, Step, Input, ...)
  version.ts        # semver + git hash
  commands/         # per-command handlers (one file each)
test/
  *.test.ts         # mirror the src/ structure where it makes sense
zorb.schema.json    # vendored at repo root, served via raw.githubusercontent.com
runners/            # (future) runner.cjs + runner.py for code actions
dist/               # (future) bundled binary output
```

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`. Use `!` only where the invariant is obvious from context.
- Prefer `undefined` over `null`, especially in types.
- File names: kebab-case for new files. Match siblings if a directory has an established style.
- Use `path.resolve` / `path.join` everywhere. Never concatenate paths with `/` — Windows support is deferred but not
  abandoned.
- Keep shell logic in `src/steps/run-shell.ts` (once it exists) and path resolution in `src/utils/resolve.ts`. Don't
  scatter them.
- Let errors bubble. Catch only at the CLI boundary (in `cli.ts`'s command dispatch).
- New commands go in `src/commands/<name>.ts`, exporting a `runX(opts)` function that returns the exit code.

## Output, colours, verbosity

The logger (`src/logger.ts`) is the only thing that writes to stdout/stderr in the CLI.

**Why not `console.log`/`console.error`?** Bun auto-colourises `console.error` when `FORCE_COLOR=1` is set, which
defeats `--no-color`. The logger uses `process.stdout.write` / `process.stderr.write` directly to keep colour control
ours.

Levels:

| Level     | Flag               | Methods that fire               |
| --------- | ------------------ | ------------------------------- |
| `quiet`   | `--quiet`          | `error`                         |
| `normal`  | (default)          | `error`, `warn`, `info`, `hint` |
| `verbose` | `-v` / `--verbose` | + `verbose`                     |
| `debug`   | `--debug`          | + `debug`                       |

Routing: `info` → stdout (program output). Everything else → stderr (diagnostics, hints, errors).

## YAML / workflow validation

- `config.ts` hand-writes strict validation, walking the YAML AST via `eemeli/yaml`'s `parseDocument` + `LineCounter`.
  Do NOT swap to a JSON-Schema-driven validator — duplicate source of truth, worse error messages.
- All validation errors are `WorkflowError(message, file, line, col, hint?)`. Format via `.format()` in the CLI.
- For unknown keys, include a "did you mean" hint using `suggestSimilar` (Levenshtein ≤ 2).
- `zorb.schema.json` (vendored at repo root) is for editor support only — not consumed at runtime.
- Workflow types live in `src/types.ts`. The `Step` type is a discriminated union (`ShellStep | ActionStep`); use the
  `isShellStep` / `isActionStep` guards rather than checking properties manually.

## Testing

- Unit tests: import the module, inject fakes (e.g. `createLogger(level, colors, { stdout, stderr })`).
- Subprocess tests: spawn `bun src/cli.ts <args>` and assert on stdout/stderr/exit code. See `test/cli-workflow.test.ts`
  for the `runCli` helper pattern (sets `NO_COLOR=1` by default; opt out per-test for colour assertions).
- New behaviour → new tests. For commands: cover missing-arg error, happy path, and `--help`.

## Env discipline

Three input paths for environment variables:

- `--env-file <path>` — load from a dotenv-style file (no override of existing process.env in the CLI itself).
- `-e KEY=VALUE` / `--env KEY=VALUE` — inline, repeatable, **overrides** earlier values (including `--env-file`).
  `-e KEY` (no value) is an explicit pass-through: copies `process.env[KEY]` into the inline layer; silently skipped if
  `KEY` is unset.
- Workflow `env:` blocks (workflow / task / step) — declarative, scope-driven.

**Strict step environment.** Shell, docker, and action steps all start from `envBase = inlineEnv` only — `process.env`
is never inherited. The build of `envBase` lives in `src/commands/run.ts`; the rationale is to stop a workflow (or an
action it consumes) from scraping credentials out of the developer's shell. If a step needs something, the workflow
declares it or the caller passes `-e KEY`. Don't reintroduce a `procEnv` layer or a shell-only escape hatch — they were
removed deliberately.

## Pitfalls discovered

- **`minimist` and `--no-foo`**: `--no-color` is parsed as `color: false`, not `'no-color': true`. The CLI scans
  `rawArgs.includes('--no-color')` instead of trusting the parsed object. Don't change this without a replacement.
- **Bun's stderr auto-colourisation**: see the logger note above.
- **`import.meta.dir`**: works in `version.ts` for resolving the git hash; don't switch to `process.cwd()`, it'll break
  when the CLI is invoked from another directory.

## Branch + commit style

- Branches: `feat/M<n>` for milestones (M2 = A2), `fix/<short>`, `chore/<short>`.
- Commit subjects: imperative, prefixed with the milestone tag when applicable: `feat(A2): YAML parser and validator`.
  Otherwise standard prefixes (`fix:`, `chore:`, `ci:`, `docs:`).
- Wrap commit bodies at ~72 chars. Explain the _why_, not the _what_.
- Atomic commits: each one should leave the tree green (typecheck + tests). When a milestone spans concerns, split into
  multiple commits (e.g. A2 was parser → env-file → list).
- **Never** mention Claude, AI, or any AI tool in commit messages or PR descriptions.

## Pull requests

- Base branch: `main`.
- CI (`.github/workflows/pull-requests.yml`) runs typecheck + tests on every PR. Don't merge red.
- For external GitHub Actions, pin to a commit SHA with the tag as a comment (`uses: org/action@<sha> # vX.Y.Z`).
  `actions/*` is trusted and can stay on tags.

## Out of scope (don't add)

- Conditional step logic (`if:`, `continue-on-error`).
- Parallel step execution.
- Task DAGs / `needs:` — composition is call-style only (`uses: ./zorb.<task>` as a step).
- Multiple tasks per invocation (`zorb run a b c`).
- Windows support (yet).

If a request touches one of these, flag it and ask before proceeding — they're explicit non-goals for the A-track.
