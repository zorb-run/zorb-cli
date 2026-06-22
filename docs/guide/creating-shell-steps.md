# Creating shell steps

A shell step is the bread and butter of a workflow — a `run:` field whose contents get handed to a shell. This guide
covers the full picture: from a one-line `echo` to multi-line scripts with timeouts, retries, and step outputs.

For the field-by-field reference, see [Workflow format → Shell steps](../reference/workflow.md#shell-steps-run). This
page is the narrative version.

## The simplest shape

A `run:` step is a string. zorb invokes `$SHELL -c <string>` (typically `bash` or `zsh`) and streams the subprocess's
stdout and stderr to your terminal.

```yml
tasks:
  hello:
    steps:
      - run: echo "Hello, zorb!"
```

```sh
$ zorb run hello
> Step 1/1: echo "Hello, zorb!"
Hello, zorb!
```

The line that starts with `>` is the **step header** — zorb prints it before each step so you can see what's running.
By default the header is the command itself; add a `name:` and zorb uses that instead:

```yml
- name: Greet
  run: echo "Hello, zorb!"
```

## Multi-line scripts

Use YAML's block scalar (`|`) for anything more than a single command. The whole block is passed to the shell as one
script, so you can use control flow, pipelines, and shell builtins exactly as you would in a `.sh` file:

```yml
- name: Build and test
  run: |
    set -euo pipefail
    npm ci
    npm test
    npm run build
```

::: tip
Start multi-line scripts with `set -euo pipefail` (or your shell's equivalent) when correctness matters. Without it, a
failing command in the middle of the script can be invisible — only the last command's exit code reaches zorb.
:::

## Choosing a shell

By default zorb uses whatever's in `$SHELL` — typically the user's interactive shell. Override it at three levels:

```yml
defaults:
  run:
    shell: /bin/bash          # workflow-wide

tasks:
  ci:
    defaults:
      run:
        shell: /bin/sh        # task-wide
    steps:
      - name: One-off
        shell: /usr/bin/env zsh    # this step only
        run: |
          setopt no_aliases
          echo "${(L)PATH}"
```

The narrowest scope wins. Use `/bin/sh` for portability, the user's `$SHELL` for ergonomics, and a specific shell only
when the script needs features unique to it.

## Working directory

Every shell step runs with a working directory. The default is the directory containing `zorb.yml` — so paths in your
script line up with what you'd type from the project root.

Override it per step or via `defaults.run.cwd`:

```yml
defaults:
  run:
    cwd: ./services
tasks:
  test-api:
    steps:
      - run: pwd                   # …/services
      - cwd: ./services/web
        run: pwd                   # …/services/web
```

Relative paths are resolved against the workflow file's directory, not the user's shell `cwd`.

## Passing values in via env

`run:` strings are passed to the shell **unmodified**. zorb deliberately does not interpolate `${{ }}` expressions
inside `run:` — that would mean two layers of substitution and surprising shell quoting bugs.

To pull a dynamic value into a script, declare it as an env var and read it natively:

```yml
tasks:
  deploy:
    inputs:
      environment:
        type: string
        required: true
    env:
      TARGET: ${{ inputs.environment }}
    steps:
      - name: Roll out
        env:
          MODE: ${{ inputs.environment == 'prod' ? 'production' : 'staging' }}
        run: echo "Deploying $TARGET in $MODE mode"
```

The env layers from low to high precedence: CLI `--env-file` / `-e` → `defaults.run.env` → workflow `env:` → task
`env:` → step `env:`. Shell steps run with the same strict, declaration-only environment as actions — see
[Environment isolation](#environment-isolation) below.

::: warning Environment isolation
Step subprocesses (shell, docker, and action) **never inherit `process.env`**. The only env vars that reach a step are
those declared in `env:` blocks or passed via `--env-file` / `-e/--env`. This is deliberate: it stops malicious or
careless workflow code from scraping your shell — `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, browser
session cookies, etc. — by reading `process.env`.

If your step needs something from the calling shell (a credential, `PATH` for an unusual install of `bun`, etc.),
opt in explicitly:

```sh
# Pass the current values of CI and GITHUB_TOKEN through to the step
zorb run release -e CI -e GITHUB_TOKEN
```

`-e KEY` (no value) takes whatever the variable is currently set to in your shell. If it isn't set, the flag is
silently skipped. Alternatively, declare values in the workflow's `env:` blocks. Either way, the dependency becomes
visible at the call site or in the file rather than lurking implicitly.
:::

::: tip
Map step outputs the same way. `${{ steps.<id>.outputs.<key> }}` is valid in `env:` but never in `run:` — declare an env
var like `TAG: ${{ steps.version.outputs.tag }}` and read `$TAG` from the script.
:::

## Producing outputs

A shell step can emit outputs that later steps consume. zorb sets a `$ZORB_OUTPUT` env var pointing at a temp file;
anything you write there in `key=value` form becomes part of the step's outputs.

```yml
tasks:
  release:
    steps:
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

Multi-line values use a heredoc-style delimiter so newlines aren't ambiguous:

```sh
{
  echo "changelog<<EOF"
  git log --pretty=format:'- %s' v1.0..HEAD
  echo
  echo "EOF"
} >> "$ZORB_OUTPUT"
```

Reference the output with `${{ steps.<id>.outputs.<key> }}`. Step IDs must be unique within a task — duplicates are a
parse-time error.

## Failure, retries, and timeouts

A non-zero exit code from the shell fails the step, which fails the task. For flaky operations, opt into retries:

```yml
- name: Pull image
  retries: 3
  backoff: exponential       # 1s, 2s, 4s …
  run: docker pull ghcr.io/example/web:latest
```

`backoff` accepts `linear` (1s, 2s, 3s …) or `exponential` (1s, 2s, 4s …). `retries: 0` is the default — one attempt
total.

For long-running commands, bound the wall-clock time:

```yml
- name: Smoke check
  timeout: 30s
  run: curl --silent --fail https://example.com/health
```

`timeout` accepts a number plus a unit — `500ms`, `30s`, `5m`, `1.5h`. When the limit hits, zorb sends `SIGTERM`, waits
briefly, then `SIGKILL` if the process is still alive. The step fails and is subject to the same retry policy as any
other failure.

::: tip
There is no `if:` or `continue-on-error`. If you need conditional behaviour, put the branching inside the script
itself — exit `0` to succeed, exit non-zero to fail. zorb deliberately keeps the surface small.
:::

## Interactive prompts

stdin is passed through to the subprocess, so interactive commands work:

```yml
- name: Login
  run: aws sso login
```

If you'd rather not block on input, prefer non-interactive flags (`--yes`, `--no-input`, etc.) or pipe an answer in.

## Containerised commands

A `run:` step gets a Docker container by adding `docker:`. The shell command runs inside the container instead of on the
host:

```yml
- name: Run migrations
  docker:
    image: postgres:16-alpine
    network: host
    volumes:
      - ./migrations:/migrations
    workdir: /migrations
  run: psql "$DATABASE_URL" -f schema.sql
```

The host filesystem is **not** auto-mounted; only paths you list under `volumes:` are visible inside the container. The
`$ZORB_OUTPUT` file is the exception — it's bind-mounted automatically so outputs work seamlessly. For the full set of
options see [Workflow format → Docker steps](../reference/workflow.md#docker-steps).

## When to reach for a code step instead

A shell step is the right tool when the work is a quick sequence of shell-native operations. The seams start to show
when:

- You're escaping quotes inside quotes inside a heredoc.
- You're parsing JSON with `jq` and stitching the results back into env vars.
- You're branching on more than two conditions, or looping non-trivially.
- You need to share helpers between multiple steps.

At that point, [create a code step](./creating-code-steps.md) — they take typed inputs, return structured outputs, and
let you write in JavaScript, TypeScript, or Python.

## Next steps

- **[Creating code steps](./creating-code-steps.md)** — when shell isn't enough.
- **[Writing actions](./actions.md)** — author the code that code steps call.
- **[Workflow format reference](../reference/workflow.md#shell-steps-run)** — every shell-step field.
