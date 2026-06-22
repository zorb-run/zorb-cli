# Why zorb?

A short, honest comparison with the things zorb usually replaces. If you're trying to decide whether zorb is worth
adding to your project — or whether to leave whatever you've got in place — read this first.

## What zorb is

A declarative local workflow runner. You write tasks in `zorb.yml`. You call them from the CLI. Tasks can shell out,
invoke containers, or run JavaScript/TypeScript/Python actions. The same `zorb run build` runs locally and in CI.

That's it. No event triggers, no remote runners, no marketplace, no DAG, no parallel execution. The scope is
deliberately small.

## vs. Makefiles

Make is forty years old, ubiquitous, and good at one thing: incremental builds where a file is the unit of work.
Pretty much everything else people use it for is a stretch.

| Concern                          | Make                                            | zorb                                          |
| -------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| Tab-indentation gotchas          | Yes, eternally                                  | No — YAML                                     |
| Shell quoting via `$$VAR`        | Yes                                             | No — env vars are first-class                 |
| Typed inputs                     | Positional args, manually parsed                | `inputs:` with `string`/`number`/`boolean`    |
| Discoverability                  | `make help` requires custom wiring              | `zorb list` is built in                       |
| Cross-platform                   | GNU Make vs BSD Make vs Windows headaches       | POSIX-only today, Windows planned             |
| File-based incremental builds    | Excellent                                       | Not the goal                                  |
| Calling code                     | Shell only                                      | Shell, Docker, or JS/TS/Python actions        |

**Stick with Make when:** the workflow really is "rebuild X when Y is newer than Z." That's what Make was designed
for, and it's still better at it than anything else.

**Switch to zorb when:** the Makefile has grown `.PHONY:` for half its targets, has stopped using file-mtime tracking
in favour of always running, and the team can't remember which underscores are which.

## vs. npm scripts (`package.json`)

The de facto Node project task runner. Cheap to start with, painful at scale.

| Concern                          | npm scripts                                      | zorb                                            |
| -------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Single-line shell strings        | Yes — and rapidly unreadable                     | Block scalars (`run: \|`) keep scripts legible  |
| Inputs / parameters              | Positional CLI args, manually parsed             | Typed `inputs:` with defaults                   |
| Conditional logic                | Cross-platform pain (`sh` syntax in `cmd.exe`)   | Same pain, but isolated to one step             |
| Composition                      | `npm run a && npm run b`                         | `uses: ./zorb.a` as a step                      |
| Cross-language work              | Awkward (shell out, parse strings)               | First-class actions                             |
| Discoverability                  | `npm run` lists scripts                          | `zorb list` lists tasks + required inputs       |
| Speed                            | Node startup overhead per script                 | Single Bun binary, no per-task startup tax      |
| Dependency on Node               | Requires Node on the runner                      | Self-contained binary; Node not needed          |

**Stick with npm scripts when:** the whole project is one Node package, the scripts fit on one line each, and there
are fewer than five of them.

**Switch to zorb when:** scripts are routinely multi-line, the same shell snippet appears in three places, or a
contributor has to read `package.json` to remember which env var goes with which command.

## vs. Just / Justfile

Just is the closest spiritual neighbour to zorb. Both are declarative task runners aimed at replacing Make. Real
differences:

| Concern                          | Just                                              | zorb                                              |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| File format                      | Custom `justfile` syntax                          | YAML                                              |
| Editor support                   | Plugin-dependent                                  | JSON Schema → autocomplete in any LSP-aware editor |
| Code actions                     | Shell only                                        | Shell, Docker, JS/TS, Python                      |
| Cross-file composition           | Imports                                           | `uses: ./other/zorb.<task>`                       |
| Env isolation                    | Inherits caller env                               | Strict, declaration-only                          |
| Secret masking                   | None                                              | First-class (`setSecret`, `***` in output)        |
| Step outputs                     | Capture via shell                                 | Native — `$ZORB_OUTPUT` for shell, return for actions |
| Distribution                     | Standalone binary, Cargo                          | Standalone binary, NPM                            |

**Stick with Just when:** the team prefers a custom DSL over YAML, the workflow is shell-only, and you don't need
typed inputs or code actions.

**Switch to zorb when:** the workflow needs to call into TypeScript or Python; secrets are part of the picture; or
you'd benefit from schema-driven editor autocomplete in `zorb.yml`.

## vs. taskfile.dev (`Taskfile.yml`)

Taskfile is the other YAML-based task runner in this space. The biggest single difference is scope:

| Concern                          | Task (taskfile.dev)                              | zorb                                              |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| File format                      | YAML                                             | YAML                                              |
| File-based dependencies          | `sources:` / `generates:` with mtime checks      | Not the goal                                      |
| Parallel execution               | Yes (`deps:` runs in parallel)                   | No — sequential, by design                        |
| Includes                         | `includes:` for namespaced sub-taskfiles         | `uses: ./other/zorb.<task>` for call-style refs   |
| Code actions                     | Shell only                                       | Shell, Docker, JS/TS, Python                      |
| Env isolation                    | Inherits caller env                              | Strict, declaration-only                          |
| Inputs                           | Variables, untyped                               | Typed `inputs:` (`string`/`number`/`boolean`)     |
| Step outputs                     | Variable interpolation between tasks             | `$ZORB_OUTPUT` (shell) / return value (actions)   |

**Stick with Task when:** you want Make-style file-based incremental builds in a YAML wrapper, or you need parallel
task execution.

**Switch to zorb when:** the workflow is more about "named tasks I run from CLI" than "rebuild graph of files"; you
want typed inputs; or you want first-class code actions.

## vs. GitHub Actions (the awkward conversation)

zorb's syntax is openly cribbed from GitHub Actions — `inputs:`, `${{ }}`, `with:`, `env:`, step outputs, the
`uses:` ref pattern. So why isn't zorb just a GitHub Actions local-runner shim?

Because they solve different problems.

| Concern                          | GitHub Actions                                    | zorb                                              |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| Where it runs                    | GitHub-hosted or self-hosted runners              | Local machine                                     |
| Trigger model                    | Events (`on: push`, `on: schedule`, etc.)         | CLI invocation (`zorb run <task>`)                |
| Parallelism                      | Jobs run in parallel; matrix strategies           | Sequential steps                                  |
| DAG                              | `needs:` between jobs                             | Call-style only (`uses: ./zorb.<task>`)           |
| Marketplace                      | Huge action ecosystem                             | Small (`@zorb/*` is just emerging)                |
| Cost                             | Free tier + paid minutes                          | Free; you own the machine                         |
| Speed on a fresh runner          | 10–30s cold start                                 | Sub-second (single binary)                        |
| Iteration loop                   | Push, wait, observe                               | Edit, `zorb run`, observe                         |
| Authoring familiarity            | Industry-standard                                 | Almost identical                                  |

**Use GitHub Actions when:** the work is event-driven (PR, push, cron), needs to run on hosted infra, or you want
the marketplace + observability stack.

**Use zorb when:** the work runs on a developer machine or inside a CI job. The signature win is that **the same
`zorb run build` you call locally is what CI calls** — no two-spec drift, no "works on my machine."

In practice, the pairing is: small `.github/workflows/ci.yml` that installs zorb and calls `zorb run ci`. zorb owns
the workflow logic. GH Actions owns the trigger and the runner. See
[Running zorb in CI](./running-in-ci.md) for the wiring.

## When zorb is the wrong tool

Be honest about the cases where you should pick something else:

- **You only have two shell commands.** A two-line shell script doesn't need a workflow runner.
- **You need file-based incremental rebuilds.** Use Make, Ninja, Bazel, or the build tool your language ecosystem
  already provides. zorb's "always run" model isn't the right shape.
- **You need to run on Windows today.** Windows support is planned but not implemented.
- **You need parallel step execution within a task.** zorb steps are sequential by design. If you need fan-out,
  invoke multiple `zorb run` from a wrapper script — or use a tool built for parallel execution.
- **You need a DAG with `needs:`.** Same answer. Composition is call-style only.
- **You want a marketplace of off-the-shelf actions.** The `@zorb/*` ecosystem is small. If you'd be pulling from
  five different community actions tomorrow, that ecosystem isn't there yet.

If two or more of those apply, zorb probably isn't the right tool today.

## The short version

Pick zorb when:

- You have more than three tasks and you'd like them documented as code rather than as a wiki page.
- Your workflow is mostly shell, mostly Docker, or mostly small bits of TypeScript/Python glue — and you want one
  declarative file describing all of it.
- You want CI and local dev to call the same commands. Drift between `package.json` `scripts:` and `.github/workflows`
  is the problem you're tired of.
- You want typed inputs, schema-driven editor support, and secret masking out of the box.

Stick with what you have when:

- Your workflow is genuinely a build graph (file-based, incremental). Make is better.
- Your workflow is genuinely event-driven (push, schedule, webhook). GH Actions is better.
- Your workflow is two lines of shell. `./scripts/build.sh` is better.

## Next steps

- **[Getting started](./getting-started.md)** — install zorb and run your first task.
- **[How zorb works](./concepts.md)** — the mental model in five minutes.
- **[Running zorb in CI](./running-in-ci.md)** — the "same workflow locally and in CI" story end-to-end.
- **[Cookbook](../cookbook/)** — concrete patterns to copy-paste.
