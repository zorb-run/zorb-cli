# zorb

Declarative local workflow runner. Define your project's tasks once in `zorb.yml`, run them anywhere.

[![NPM version](https://img.shields.io/npm/v/zorb.svg)](https://www.npmjs.com/package/zorb)
[![License](https://img.shields.io/npm/l/zorb.svg)](./LICENSE)

> Early development. The shape of the YAML and CLI may still shift before 1.0.

## Why

Most projects accumulate ad-hoc shell scripts, Makefiles, and `package.json` scripts that drift apart as the project
grows. `zorb` replaces them with a single declarative file. Tasks, inputs, environment, and step composition all live in
`zorb.yml` — and the same workflow runs locally and in CI.

## Example

```yml
# zorb.yml
tasks:
  build:
    description: Build the project
    steps:
      - run: bun install --frozen-lockfile
      - run: bun run build

  deploy:
    description: Deploy to a target environment
    inputs:
      environment:
        type: string
        required: true
    env:
      TARGET: ${{ inputs.environment }}
    steps:
      - uses: ./zorb.build
      - run: ./scripts/deploy.sh
```

```sh
zorb list                                   # list every task
zorb run build                              # run a task
zorb run deploy --with environment=staging  # pass inputs
zorb run build --watch                      # re-run on file changes
zorb init                                   # scaffold a zorb.yml
zorb --help                                 # everything else
```

## Features

- **Shell, Docker, and code actions.** Run shell commands directly, inside a Docker container, or invoke JavaScript,
  TypeScript, or Python actions in the same workflow.
- **Inputs, env, and expressions.** Borrows expression syntax (`${{ }}`), inputs, outputs, and secrets from GitHub
  Actions — so it feels obvious from the first read.
- **Composition over orchestration.** Call other tasks (`uses: ./zorb.<task>`) including across files. No DAG, no
  `needs:`, no parallel-step config — keep workflows readable.
- **Strict environment.** Steps don't inherit your shell's environment by default. Workflows declare what they need.
- **Native binaries.** Distributed via NPM with a tiny Node shim (`bin/zorb.cjs`) that dispatches to the right
  `dist/<platform>/zorb` binary.

## Install

```sh
# via npm (recommended)
npm install -g zorb

# or run without installing
npx zorb --help
```

Homebrew distribution is on the roadmap.

## Documentation

Full guide, CLI reference, workflow reference, cookbook, and CI integration notes:

→ **<https://docs.zorb.run>**

Quick links:

- [Getting started](https://docs.zorb.run/guide/getting-started)
- [Workflow reference](https://docs.zorb.run/reference/workflow)
- [CLI reference](https://docs.zorb.run/reference/cli)
- [Cookbook](https://docs.zorb.run/cookbook/)

## Contributing

Bug reports, feature ideas, and PRs are all welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev loop, testing
guide, and release process.

## License

MIT — see [LICENSE](./LICENSE).
