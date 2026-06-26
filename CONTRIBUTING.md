# Contributing to zorb

Thanks for taking a look! This guide covers everything you need to hack on the CLI.

- [Tooling](#tooling)
- [Working locally](#working-locally)
- [Integration tests](#integration-tests)
- [Publishing packages](#publishing-packages)

---

## Tooling

`zorb` is a Bun project. Almost everything (runtime, test runner, bundler, formatter driver) runs through Bun.

### Required

- **[Bun](https://bun.com)** ≥ 1.3.13 — runtime, test runner, and bundler. Pinned in `engines.bun` in `package.json` and
  in CI.
- A POSIX shell (macOS or Linux). Windows support is deferred.
- **Git**.

```sh
# macOS
brew install oven-sh/bun/bun

# anywhere
curl -fsSL https://bun.com/install | bash
```

### Optional (for some integration tests)

- **Docker** — needed for the Docker step suite (`integration-tests/docker/`). Tests skip cleanly when Docker isn't
  present; CI's Linux runner sets `ZORB_REQUIRE_DOCKER=1` to flip a missing daemon into a hard failure.
- **Python 3** — needed for the Python action suite (`integration-tests/code/python.test.sh`). Same skip-or-require
  behaviour as Docker.

### For publishing

Maintainers don't need anything beyond the above — releases run end-to-end on CI through GitHub Actions and
[changesets](https://github.com/changesets/changesets). You only need `npm` locally if you want to test a tarball before
publishing; see [Publishing packages](#publishing-packages).

### Project layout

```
src/
  cli.ts            # entrypoint: arg parsing + command dispatch
  colors.ts         # ANSI helper; honours NO_COLOR / FORCE_COLOR / --no-color
  config.ts         # workflow finder + parser + strict validator
  context.ts        # task execution context (env, inputs, outputs)
  envfile.ts        # dotenv-style parser for --env-file
  expressions.ts    # ${{ ... }} engine
  help.ts           # top-level and per-command help text
  inputs.ts         # input parsing / validation
  logger.ts         # verbosity-aware logger (writes stdout/stderr directly)
  types.ts          # workflow shape types
  version.ts        # semver + git hash for `--version`
  action.ts         # public `zorb/action` type surface for action authors
  commands/         # one file per CLI command (init, list, run, run-watch, use)
  steps/            # step executors (shell, docker, action)
  utils/            # shared helpers (path resolve, etc.)
test/               # unit + spawned-CLI + binary-smoke tests
integration-tests/  # shell-script end-to-end suite (see below)
runners/            # runner.cjs (Node) + runner.py (Python) for code actions
scripts/            # build.ts, validate-schema.ts
docs/               # VitePress site (docs.zorb.run)
examples/           # example zorb.yml files referenced from the docs
zorb.schema.json    # JSON Schema for editor support (not runtime-consumed)
bin/zorb.cjs        # NPM-installed dispatcher; execs dist/<host>/zorb at runtime
```

---

## Working locally

### Setup

```sh
git clone git@github.com:zorb-run/zorb-cli.git
cd zorb-cli
bun install
```

### Run the CLI from source

While iterating, run the TypeScript entrypoint directly — no build required:

```sh
bun src/cli.ts --help
bun src/cli.ts run build
bun src/cli.ts list
```

There's a shorthand:

```sh
bun run dev -- run build
```

### Build the binary

For tests or to mirror how users will invoke `zorb`, compile a host-platform binary:

```sh
bun run build -- --current
./dist/$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')/zorb --version
```

| Command                            | What it does                                    |
| ---------------------------------- | ----------------------------------------------- |
| `bun run build`                    | Build binaries for all four supported platforms |
| `bun run build -- --current`       | Build only the host-platform binary             |
| `bun run build -- --target=<plat>` | Build a specific platform                       |

Supported targets: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`.

The output layout is:

```
dist/
  <platform>/zorb       # compiled binary per target
  runners/              # runner.cjs + runner.py, shared across targets
```

`bin/zorb.cjs` (the NPM-installed dispatcher) inspects `process.platform` + `process.arch` and execs the matching
`dist/<host>/zorb` binary. The binary resolves `dirname(execPath)/../runners/` for code actions, so all four binaries
share the single `dist/runners/` directory.

### Lint and format

Formatting is Prettier-driven; there's no separate linter.

```sh
bun run format          # rewrite files in place
```

### Typecheck

```sh
bun run typecheck
```

Strict TypeScript with `noUncheckedIndexedAccess`. Use `!` only where the invariant is obvious from context.

### Unit tests

```sh
bun run test:unit       # or `bun test`
```

This runs three flavours of test under `test/`:

1. **Unit tests** for small modules (`colors`, `logger`, `envfile`, etc.) — import directly and inject fakes.
2. **Spawned-CLI tests** (`test/cli-*.test.ts`) — spawn `bun src/cli.ts <args>` and assert on stdout / stderr / exit
   code. The helper sets `NO_COLOR=1` by default; opt out per-test for colour-related cases.
3. **Binary smoke tests** (`test/smoke.test.ts`) — compile the host binary and run `--version` against it. Adds a
   one-off ~150ms compile to the suite; set `ZORB_SKIP_SMOKE=1` to skip during tight inner loops.

Aim to add a test alongside any new behaviour. For new CLI commands, cover at least: missing-arg error, happy path,
`--help`.

### Output, colours, and verbosity

The logger (`src/logger.ts`) is the only thing that should write to stdout/stderr in the CLI. It bypasses
`console.log`/`console.error` because Bun auto-colourises `console.error` under `FORCE_COLOR`, which would defeat
`--no-color`.

| Level     | Flag               | Methods that fire               |
| --------- | ------------------ | ------------------------------- |
| `quiet`   | `--quiet`          | `error`                         |
| `normal`  | (default)          | `error`, `warn`, `info`, `hint` |
| `verbose` | `-v` / `--verbose` | + `verbose`                     |
| `debug`   | `--debug`          | + `debug`                       |

Routing: `info` → stdout (program output). Everything else → stderr (diagnostics, hints, errors).

### Coding conventions

- **Keep it simple.** Small functions, clear names, no clever tricks.
- **Match the existing style.** Read neighbouring code before adding new patterns.
- **Prefer `undefined` over `null`**, especially in types.
- **Use `path.resolve` / `path.join`** for any filesystem paths — Windows support is deferred but not abandoned.
- **No `${{ }}` expressions inside `run:` strings.** `run:` is passed to the shell unmodified — declare values in `env:`
  and read them natively.
- **Let errors bubble.** Catch only at the CLI boundary (in `cli.ts`'s command dispatch). Don't swallow.

### Commit style

- One commit per logical change.
- Subject line is short and imperative: `feat(A2): YAML parser and validator`, `fix run: cwd default`, etc.
- Wrap the body at ~72 chars. Explain the _why_, not the _what_.
- No AI-tool trailers.

### Pull requests

- Branch from `main`. Name branches `feat/<short>`, `fix/<short>`, or `chore/<short>`.
- Before pushing: `bun run typecheck && bun run test:unit && bun run format`. Run integration tests too if you're
  touching anything that bundles, spawns subprocesses, or talks to runners.
- Keep PRs small. Each commit should leave the tree green.
- **Add a changeset** for any user-visible change — see [Publishing packages](#publishing-packages).

---

## Integration tests

End-to-end shell scripts under `integration-tests/` exercise the **compiled binary** against real `zorb.yml` workflows.
They cover shell execution, nested workflows, code actions, and Docker steps — the surface area where bundling, runner
discovery, and subprocess plumbing can regress in ways `bun test` won't catch.

### Suite layout

```
integration-tests/
  lib.sh                  # shared helpers (assert_*, zorb wrapper)
  run.sh                  # discovery + runner
  shell/                  # shell-step behaviour
  code/                   # cjs + python actions
  docker/                 # docker-step behaviour (skipped without docker)
  nested-workflows/       # uses: ./zorb.<task> + cross-file composition
```

### Running them

The harness runs the compiled binary at `dist/<host>/zorb` — it does **not** auto-build, because (a) the build belongs
to its own CI step and (b) a silent rebuild hides the wrong-binary class of bug. Build first:

```sh
bun run build -- --current
```

Then:

```sh
bun run test:integration                            # run all
./integration-tests/run.sh shell/basic.test.sh      # run one (path relative to integration-tests/)
ZORB_BIN=/path/to/zorb ./integration-tests/run.sh   # point at a binary built elsewhere
```

### Skip vs require

Tests that need optional tooling (Docker, Python 3) **skip cleanly** when it's missing, so the suite stays green on
machines that don't have them.

To turn a missing tool into a **hard failure** instead (so coverage stays honest), set:

- `ZORB_REQUIRE_DOCKER=1`
- `ZORB_REQUIRE_PYTHON=1`

CI sets these per-runner — the Linux runner requires Docker; macOS GitHub-hosted runners don't have a daemon, so they
skip.

### Adding a test

Drop a `<name>.test.sh` (and any fixtures) into one of the four suite directories:

```sh
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib.sh"

zorb run my-task --with foo=bar > out.log
assert_contains out.log "expected output"
```

`zorb` inside a test is already pointed at the binary under test. Use `assert_*` helpers from `lib.sh` instead of
hand-rolling `[[ ]]` comparisons — error messages stay consistent.

---

## Publishing packages

Releases are driven by [changesets](https://github.com/changesets/changesets) and the `.github/workflows/release.yml`
pipeline. **No manual tagging, no manual `npm publish`** — merging a PR with a changeset is the entire mechanism.

### Adding a changeset

Any PR that changes user-visible behaviour needs a changeset:

```sh
bunx changeset
```

Pick the bump type (`patch` / `minor` / `major`) and write a short summary — that summary lands in `CHANGELOG.md` and
the GitHub Release notes verbatim. The command creates a markdown file under `.changeset/`; commit it with the rest of
your changes.

Skip the changeset for changes that are invisible to users (CI tweaks, internal refactors, doc-only edits in `docs/`).

### What happens on merge to `main`

The `Release` workflow runs on every push to `main`:

1. **If there are unprocessed changesets** in `.changeset/`, [changesets/action](https://github.com/changesets/action)
   opens (or updates) a PR titled `ci: version packages`. That PR bumps `package.json`, regenerates `CHANGELOG.md`, and
   deletes the consumed changeset files.
2. **When the version PR merges,** the workflow runs again — this time there are no changesets and `package.json` has a
   bumped version. `changesets/action` runs `npx changeset publish`, which:
   - Runs `prepack` → `bun run build` → cross-compiles the four-platform binaries into `dist/`.
   - Publishes the package to NPM via [npm Trusted Publisher](https://docs.npmjs.com/trusted-publishers) — the GitHub
     OIDC token (granted by `id-token: write`) is exchanged for publish rights. No `NPM_TOKEN` required. `--provenance`
     and `--access public` come from `publishConfig` in `package.json`.
   - Creates a `v<version>` GitHub Release with the new `CHANGELOG.md` section as the body
     (`createGithubReleases: true`).
3. **Then,** conditional steps in the workflow package each of the four binaries as `zorb-<platform>.tar.gz` (containing
   `zorb-<platform>/bin/zorb` + `zorb-<platform>/runners/`), generate a `SHA256SUMS` file, and attach the lot to the
   release via `gh release upload --clobber`.

### Common scenarios

| Situation                            | What to do                                                            |
| ------------------------------------ | --------------------------------------------------------------------- |
| New feature, bugfix, breaking change | Add a changeset (`bunx changeset`) in your PR. Done.                  |
| CI / dev-only / doc-only change      | No changeset needed.                                                  |
| Forgot a changeset on a merged PR    | Open a follow-up PR with just the changeset file.                     |
| Multiple PRs, single release         | Each PR adds its own changeset. They bundle into the next version PR. |

### Things not to do

- Don't bump `version` in `package.json` by hand — the version PR does it.
- Don't tag releases manually — `changesets/action` creates the `v<version>` tag + GitHub Release as part of publish.
- Don't run `npm publish` from your laptop — Trusted Publisher provenance only works from the CI workflow.
- Don't merge the `ci: version packages` PR until you're happy with the bundled changelog. Re-running the workflow on a
  later push will update the PR in place.

### Pre-release checklist (the version PR)

When the bot's `ci: version packages` PR is open and ready to merge:

1. CI is green on `main` (so no regression rides along).
2. `CHANGELOG.md` reads sensibly — if a changeset summary is unclear, edit it on the version PR before merging.
3. The version bump matches the change set (patch/minor/major). If it doesn't, push an extra changeset to the source
   branch and re-merge.

That's it — merging publishes.
