# Examples

Self-contained workflow files showing different parts of the format. Try any of them with:

```sh
zorb list -f examples/<name>.yml
```

| Example                          | What it shows                                  |
| -------------------------------- | ---------------------------------------------- |
| [`basic.yml`](./basic.yml)       | Minimal tasks with `run:` steps                |
| [`inputs.yml`](./inputs.yml)     | Typed inputs (`string`, `boolean`, `number`)   |
| [`env.yml`](./env.yml)           | `env:` at workflow, task, and step scope       |
| [`defaults.yml`](./defaults.yml) | `defaults.run.{shell, cwd, env}` precedence    |
| [`docker.yml`](./docker.yml)     | `docker:` short and long form                  |
| [`actions.yml`](./actions.yml)   | `uses:` for local actions, NPM, and cross-file |

Every example pins the JSON schema for editor autocomplete:

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/zorb-run/zorb-cli/main/zorb.schema.json
```

Some examples reference features (shell execution, expressions, action runners) that are still under development — the
files parse cleanly and `zorb list` works against any of them, but full execution lands progressively.
