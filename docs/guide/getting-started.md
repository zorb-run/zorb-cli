# Getting started

zorb is a small command-line tool that reads `zorb.yml` files and runs the tasks they declare. This page walks through
installing it, creating a workflow, and growing it through the features you'll reach for first.

## Install

zorb ships as a single binary distributed through NPM:

::: code-group

```sh [npm]
npm install --global zorb
```

```sh [bun]
bun add --global zorb
```

```sh [pnpm]
pnpm add --global zorb
```

:::

Verify it:

```sh
zorb --version
```

::: tip
zorb requires no Node version — the binary embeds its runtime. Install once, ignore it forever.
:::

## Your first workflow

Scaffold a workflow in the current directory:

```sh
zorb init
```

You should see a `zorb.yml` like this:

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/zorb-run/zorb-cli/main/zorb.schema.json

tasks:
  hello:
    description: Print a greeting
    steps:
      - run: echo "Hello, zorb!"
```

List the tasks:

```sh
$ zorb list
hello — Print a greeting
```

Run one:

```sh
$ zorb run hello
> Step 1/1: echo "Hello, zorb!"
Hello, zorb!
```

## Add a multi-step task

Tasks can have any number of steps. They run in order, and a non-zero exit fails the task.

```yml
tasks:
  build:
    description: Install, test, and bundle
    steps:
      - name: Install
        run: npm ci
      - name: Test
        run: npm test
      - name: Bundle
        run: npm run build
```

`name:` is optional — without it the step header is the command itself. Multi-line YAML strings (`|`) get passed to the
shell as a single script:

```yml
- name: Smoke check
  run: |
    npm pack --dry-run
    node -e "require('./')"
```

## Take inputs from the CLI

Tasks accept typed inputs that you pass with `--with`:

```yml
tasks:
  deploy:
    description: Deploy to a target environment
    inputs:
      environment:
        description: Target environment
        type: string
        required: true
      dry-run:
        type: boolean
        default: false
    env:
      TARGET: ${{ inputs.environment }}
      MODE: '${{ inputs.dry-run ? "dry-run" : "apply" }}'
    steps:
      - run: echo "Deploying $TARGET ($MODE)"
```

```sh
zorb run deploy --with environment=staging
zorb run deploy --with environment=production dry-run=true
```

`--with` takes one or more space-separated `key=value` pairs and is not repeatable. `boolean` inputs accept
`true/false`, `yes/no`, and `1/0`. See [Workflow format → Inputs](../reference/workflow.md#inputs) for the full
surface.

::: tip
`${{ }}` expressions work in `env:` and `with:`, never in `run:`. Map a value to an env var, then read it natively in
the shell. This avoids two layers of substitution and keeps shell scripts readable.
:::

## Layer in environment variables

`env:` is a mapping you can set at three scopes — workflow, task, and step. Inner scopes override outer ones.

```yml
env:
  PROJECT: my-app
  LOG_LEVEL: info

tasks:
  build:
    env:
      NODE_ENV: production
    steps:
      - run: echo "$PROJECT — $NODE_ENV — $LOG_LEVEL"

      - name: Step-level override
        env:
          LOG_LEVEL: debug
        run: echo "$LOG_LEVEL" # debug
```

The CLI can supplement env from outside the file:

```sh
zorb run build --env-file .env.local
zorb run build -e CI=true -e LOG_LEVEL=debug
zorb run build -e CI -e GITHUB_TOKEN     # pass-through from the current shell
```

`-e KEY` (no value) takes whatever the variable is currently set to in the shell that invoked `zorb`; if it isn't set,
the flag is a silent no-op. Inline `-e` overrides values from `--env-file`, which in turn sit below workflow `env:`.

::: warning Steps don't inherit `process.env`
Shell, docker, and action steps all run with a strict, declaration-only environment — `process.env` is **never**
forwarded automatically. If a step needs a value from your shell, declare it in `env:` or pass it with `-e KEY`. See
[Workflow format → Env](../reference/workflow.md#env) for the full rules.
:::

## Compose tasks with `uses:`

Reference another task as a step with `uses:`:

```yml
tasks:
  build:
    steps:
      - run: npm run build

  ship:
    description: Build and push
    steps:
      - uses: ./zorb.build
      - run: ./scripts/push.sh
```

The same mechanism works across files — `uses: ./infra/zorb.deploy` calls the `deploy` task from `./infra/zorb.yml`.

For code-based steps, `uses:` runs an action file in JavaScript, TypeScript, or Python. See
[Writing actions](./actions.md) for the full guide.

## Next steps

- **[Why zorb?](./why-zorb.md)** — how zorb compares to Make, npm scripts, Just, taskfile.dev, and GitHub Actions.
- **[How zorb works](./concepts.md)** — the mental model in five minutes: workflows, tasks, steps, actions.
- **[Creating workflows](./creating-workflows.md)** — the full picture of building a `zorb.yml`.
- **[Creating shell steps](./creating-shell-steps.md)** — everything `run:` can do.
- **[Creating code steps](./creating-code-steps.md)** — call actions and other tasks with `uses:`.
- **[Writing actions](./actions.md)** — author code that workflows can call.
- **[Running zorb in CI](./running-in-ci.md)** — GitHub Actions, GitLab CI, CircleCI integration patterns.
- **[Cookbook](../cookbook/)** — worked recipes for common workflow shapes.
- **[Workflow format reference](../reference/workflow.md)** — every key zorb understands.
- **[CLI reference](../reference/cli.md)** — every command and flag.
- **[Expressions](../reference/expressions.md)** — variables, operators, functions, filter syntax.
- **[Security model](../reference/security.md)** — what zorb's defaults protect against, and what they don't.
- **[Troubleshooting](./troubleshooting.md)** — common gotchas with their fixes.
