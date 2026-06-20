# Contributing to zorb

Thanks for taking a look! This guide covers everything you need to hack on the CLI.

## Prerequisites

- [Bun](https://bun.com) ≥ 1.1.0 — runtime, test runner, and bundler all in one.
- A POSIX shell (macOS or Linux). Windows isn't supported yet.

```sh
# macOS
brew install oven-sh/bun/bun
# or anywhere
curl -fsSL https://bun.com/install | bash
```

## Setup

```sh
git clone git@github.com:zorb-run/zorb-cli.git
cd zorb-cli
bun install
```

## Running the CLI

Run the source directly while iterating:

```sh
bun src/cli.ts --version
bun src/cli.ts --help
bun src/cli.ts run build
```

The `dev` script is a shortcut:

```sh
bun run dev -- run build
```

To run the compiled binary the way users will, build it first:

```sh
bun scripts/build.ts --current
./dist/$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')/zorb --version
```

## Common commands

| Command                             | What it does                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `bun test`                          | Run the test suite (unit + spawned CLI + binary smoke)                         |
| `bun run typecheck`                 | Type-check with `tsc --noEmit`                                                 |
| `bun run format`                    | Format with Prettier                                                           |
| `bun run dev`                       | Run the CLI from source                                                        |
| `bun run build`                     | Build compiled binaries for all four supported platforms into `dist/`          |
| `bun scripts/build.ts --current`    | Build only the host-platform binary (used by smoke tests)                      |
| `bun scripts/build.ts --target=<p>` | Build a specific platform: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64` |

## Binary distribution

`zorb` ships on NPM as a single package laid out like this:

```
bin/zorb.cjs           # dispatcher, registered as the package's `bin` entry
dist/<platform>/zorb   # compiled binary for each of the four targets
dist/runners/          # action runners (runner.cjs, runner.py), shared across targets
```

The dispatcher inspects `process.platform` + `process.arch` and execs `../dist/<host>/zorb` with the user's args. The
compiled binary resolves `dirname(execPath)/../runners/` for code actions, so the four binaries share the single
`dist/runners/` directory.

`bun scripts/build.ts` produces the layout above.

Set `ZORB_SKIP_SMOKE=1` to skip the binary smoke tests during local iteration (they add a one-off ~150ms compile to
`bun test`).

## Project layout

```
src/
  cli.ts          # entrypoint: arg parsing + command dispatch
  colors.ts       # ANSI helper; honours NO_COLOR / FORCE_COLOR / --no-color
  help.ts         # top-level and per-command help text
  logger.ts       # verbosity-aware logger (writes to stdout/stderr directly)
  version.ts      # semver + git hash for `--version`
test/
  cli.test.ts     # spawns the CLI and asserts on stdout/stderr/exit code
  colors.test.ts  # unit tests for the colour helper
  logger.test.ts  # unit tests for the logger
```

The layout will grow over time — `src/steps/`, `src/utils/`, and `runners/` arrive alongside the features that need
them.

## Coding conventions

- **Keep it simple.** Small functions, clear names, no clever tricks. If something feels over-engineered, it probably
  is.
- **Match the existing style.** Read neighbouring code before adding new patterns.
- **Prefer `undefined` over `null`**, especially in types.
- **Use `path.resolve` / `path.join`** for any filesystem paths — Windows support is deferred but not abandoned.
- **No `${{ }}` expressions inside `run:` strings.** `run:` is passed to the shell unmodified — declare values in `env:`
  and read them natively.
- **Let errors bubble.** Catch only at the CLI boundary. Don't swallow.

## Output, colours, and verbosity

The logger (`src/logger.ts`) is the only thing that should write to stdout/stderr in the CLI. It bypasses
`console.log`/`console.error` because Bun auto-colourises `console.error` under `FORCE_COLOR`, which would defeat
`--no-color`.

Levels:

| Level     | Flag               | Methods that fire               |
| --------- | ------------------ | ------------------------------- |
| `quiet`   | `--quiet`          | `error`                         |
| `normal`  | (default)          | `error`, `warn`, `info`, `hint` |
| `verbose` | `-v` / `--verbose` | + `verbose`                     |
| `debug`   | `--debug`          | + `debug`                       |

Routing:

- `info` → stdout (program output)
- everything else → stderr (diagnostics, hints, errors)

## Testing

Use `bun test`. We have two flavours:

1. **Unit tests** for small modules (`colors`, `logger`) — import directly and inject fake streams.
2. **Subprocess tests** for the CLI (`test/cli.test.ts`) — spawn `bun src/cli.ts <args>` and assert on
   stdout/stderr/exit code. The helper sets `NO_COLOR=1` by default so assertions stay readable; opt out per-test for
   colour-related cases.

Aim to add a test alongside any new behaviour. If you're adding a command, cover at least: missing-arg error, happy
path, `--help`.

## Commit style

- One commit per logical change.
- Subject line is short and imperative: `A2: walk parents for zorb.yml`, `fix run: cwd default`, etc.
- Wrap the body at ~72 chars. Explain the _why_, not the _what_.
- No AI-tool trailers.

## Pull requests

- Branch from `main`. Name branches `feat/<short>`, `fix/<short>`, or `chore/<short>`.
- Before pushing: `bun run typecheck && bun test && bun run format`.
- Keep PRs small. If a milestone spans multiple files, split where it makes sense — each commit should leave the tree
  green.
