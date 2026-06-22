# Running zorb in CI

The whole point of declaring tasks in `zorb.yml` is that the same `zorb run build` you type locally is what CI runs.
This page covers the practical details: how to install zorb on a runner, how to feed secrets in cleanly, how to keep
the log readable, and what to leave switched off.

## The mental model

A CI job is just another shell that calls `zorb run <task>`. There's no zorb-specific CI plugin, no marketplace
action, no service. The runner does three things:

1. Install the `zorb` binary (or `bun`/`node` + the NPM package).
2. Provide secrets via environment variables that you forward in with `-e`.
3. Invoke `zorb run <task>` and propagate its exit code.

If the local invocation works, the CI invocation works — by design.

## Installing zorb on a runner

zorb ships as a single binary on NPM. Three install flavours, in increasing order of "what's already on this runner":

```sh
# 1. Pre-built binary via NPM (smallest, fastest — recommended for CI)
npm install --global zorb

# 2. Via Bun (if the runner already has Bun)
bun add --global zorb

# 3. Via pnpm
pnpm add --global zorb
```

The published binary embeds its Bun runtime, so the runner doesn't need Bun installed separately for shell or
JavaScript/TypeScript actions to work. **Python actions** still need `python3` available on `PATH`.

Verify:

```sh
zorb --version
```

## GitHub Actions

The most common pairing. Wire `zorb` into a normal `run:` step:

```yml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install zorb
        run: npm install --global zorb

      - name: Test
        env:
          CI: 'true'
        run: zorb run test --quiet

      - name: Build
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: zorb run build -e GITHUB_TOKEN
```

A few patterns worth pointing out:

- **`--quiet`** trims zorb's progress chrome (step headers, hints) and only prints errors. The captured output from
  the underlying commands still appears.
- **`-e GITHUB_TOKEN`** (no value) forwards whatever GH Actions has populated into the runner's env. The same flag is
  what you'd use locally — `-e GITHUB_TOKEN=ghp_xxx` works too.
- **`env:` block** on the GHA step sets the variable in the runner's process env. zorb then forwards it explicitly
  via `-e`. Don't expect zorb to pick it up implicitly — step subprocesses don't inherit `process.env`.

### Reusable workflow snippet

For repos with many jobs, lift the install into a reusable workflow or composite action:

```yml
# .github/actions/setup-zorb/action.yml
name: Set up zorb
description: Install zorb on the runner
runs:
  using: composite
  steps:
    - shell: bash
      run: npm install --global zorb
```

```yml
# .github/workflows/ci.yml
- uses: ./.github/actions/setup-zorb
- run: zorb run test --quiet
```

## GitLab CI

```yml
# .gitlab-ci.yml
default:
  image: node:20-alpine

stages: [test, build]

test:
  stage: test
  script:
    - npm install --global zorb
    - zorb run test --quiet

build:
  stage: build
  variables:
    NODE_ENV: production
  script:
    - npm install --global zorb
    - zorb run build -e DEPLOY_TOKEN
  rules:
    - if: $CI_COMMIT_TAG
```

GitLab's `variables:` block sets process env on the runner, just like GitHub's `env:`. `-e DEPLOY_TOKEN` then forwards
it into the zorb step. Mask sensitive variables in your project settings so they don't leak into job logs even
without zorb's masker.

## CircleCI

```yml
# .circleci/config.yml
version: 2.1
jobs:
  test:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run:
          name: Install zorb
          command: npm install --global zorb
      - run:
          name: Test
          command: zorb run test --quiet
      - run:
          name: Build
          environment:
            NODE_ENV: production
          command: zorb run build -e DEPLOY_TOKEN
```

Context-defined secrets surface as env vars on the executor, so `-e DEPLOY_TOKEN` forwards them cleanly.

## Generic Docker-based runner

If your CI's runner spec is "a container image and a script," roll your own minimal Docker image:

```Dockerfile
# Dockerfile.zorb
FROM node:20-alpine
RUN npm install --global zorb && \
    apk add --no-cache python3 docker-cli
WORKDIR /workspace
ENTRYPOINT ["zorb"]
```

Build once, push it to your registry, and call it from any CI that supports image-based jobs:

```sh
docker run --rm -v "$PWD":/workspace ghcr.io/example/zorb-ci run test --quiet
```

Add `docker-cli` only if your workflow uses `docker:` steps; add `python3` only if it has Python actions. Strip
either out otherwise.

## Forwarding secrets

The pattern, in three escalating tiers:

### Tier 1 — pass through with `-e KEY`

The CI exposes the secret as a runner env var; you forward it explicitly.

```sh
zorb run release -e NPM_TOKEN -e GITHUB_TOKEN
```

If the variable isn't set in the runner's env, the flag silently skips — useful for optional credentials.

### Tier 2 — load from a CI-provided file

Some CI systems write secrets to a file. Point `--env-file` at it:

```sh
zorb run deploy --env-file "$CI_SECRETS_FILE"
```

Values from `--env-file` populate the inline env layer; per-environment files keep production credentials separate
from staging ones.

### Tier 3 — a `secrets:` loader

For production-grade pipelines, load secrets at run time from a real secret store:

```yml
secrets:
  - uses: '@zorb/secrets/load-1password'
    with:
      vault: CI
      items: [NPM_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]
```

The loader needs its own bootstrap credential (a service account token), which you still pass via `-e` — but only one
credential reaches zorb instead of N. The loader handles the fan-out, and the resulting values are masked in step
output.

See [Security model → Recommendations](../reference/security.md#recommendations) for why loaders beat `--env-file`
for real secrets.

## Output, colours, and log volume

A few flags that read better in CI than on a terminal:

| Flag                | When to use                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `--quiet`           | The default for CI. Drops zorb's progress chrome; underlying command output still appears.        |
| `--verbose`         | When a build mysteriously fails and the headline output isn't enough. One level up from default.  |
| `--debug`           | When you suspect zorb itself, not your script. Dumps resolution, env layering, masking decisions. |
| `--no-color`        | Force-disable colour. Honoured even if `FORCE_COLOR` is set in the runner env.                    |
| `NO_COLOR=1` (env)  | Same effect, runner-wide.                                                                         |

Most CI log viewers handle ANSI well, so leaving colour on is usually fine. Force-disable only when you're piping
output to a non-ANSI consumer (S3, a JSON-shaped sink, a chat notification).

## Exit codes

CI systems read the exit code to decide pass/fail. zorb's mapping:

| Code  | Meaning                                                                |
| ----- | ---------------------------------------------------------------------- |
| `0`   | Success.                                                               |
| `1`   | Task failed (validation, missing input, step exit, action throw).      |
| _n_   | Otherwise the step's exit code.                                        |
| `130` | `SIGINT` — runner cancelled the job (e.g. user pressed cancel).        |
| `143` | `SIGTERM` — supervisor killed the job (e.g. timeout, OOM).             |

Most CI systems treat any non-zero exit as failure and 130/143 as cancellation rather than failure. If yours
doesn't, post-process the exit code yourself.

## Things to leave switched off in CI

A short kill-list:

- **`--watch`** — never. It runs forever; CI jobs need to terminate.
- **Interactive prompts** in shell steps. CI has no stdin; tools that prompt will hang. Pass `--yes`, `--no-input`,
  `BATCH=1`, or whatever the tool's non-interactive flag is.
- **`docker:` steps that don't pull deterministically.** Pin the image tag and set `pull: always` for releases, or
  `pull: if-not-present` (the default) for everything else. Floating `:latest` plus aggressive runner caching is the
  recipe for "works on my machine."
- **Trusting `process.env`.** zorb's strict-env policy means steps see only what you declare. Don't rely on a magic
  `CI=true` propagation — pass it explicitly via `-e CI=true` if a step needs it.

## A reference shape

A workflow that holds up well in CI usually looks like:

```yml
tasks:
  ci:
    description: The full CI pipeline — same locally and on the runner
    steps:
      - uses: ./zorb.lint
      - uses: ./zorb.typecheck
      - uses: ./zorb.test
      - uses: ./zorb.build

  lint:
    steps:
      - run: npm run lint

  typecheck:
    steps:
      - run: npm run typecheck

  test:
    steps:
      - run: npm test

  build:
    steps:
      - run: npm run build
```

Then your CI is one line:

```sh
zorb run ci --quiet
```

Each task is independently runnable, which means a contributor can reproduce a CI failure locally with the exact
command the runner used. That's the property to optimise for.

## See also

- **[CLI reference](../reference/cli.md)** — every flag in this guide.
- **[Loading env from a dotenv file](../cookbook/load-env-from-dotenv.md)** — `--env-file` patterns.
- **[Security model](../reference/security.md)** — secret forwarding, masking, and what _not_ to do.
- **[Troubleshooting → My env var isn't visible](./troubleshooting.md#my-env-var-isn-t-visible-inside-the-step)** — the
  single most common CI gotcha.
