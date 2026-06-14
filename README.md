# zorb

Declarative local workflow runner. Define tasks in `zorb.yml`, run them with `zorb run <task>`.

> Early development — the CLI parses commands but doesn't execute tasks yet.

## Example

```yml
# zorb.yml
tasks:
  build:
    description: Build the project
    steps:
      - run: echo "Building..."

  deploy:
    inputs:
      environment:
        type: string
        required: true
    env:
      TARGET: ${{ inputs.environment }}
    steps:
      - run: echo "Deploying to $TARGET"
```

```sh
zorb run build
zorb run deploy --with environment=staging
zorb list
zorb --help
```

## Install

Not yet published. See [CONTRIBUTING.md](./CONTRIBUTING.md) to run from source.

## Links

- Contributing: [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

MIT — see [LICENSE](./LICENSE).
