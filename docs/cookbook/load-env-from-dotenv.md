# Loading env from a dotenv file

Use `--env-file` to populate the inline env layer from a `.env`-formatted file, then let workflow / task / step `env:`
blocks layer on top. Most useful when you keep per-environment files (`.env.staging`, `.env.production`) committed at
the repo root.

## The shape

```yml
# zorb.yml
tasks:
  migrate:
    description: Apply database migrations
    env:
      # Workflow-level env still wins over --env-file, so safe defaults belong here.
      LOG_LEVEL: ${{ env.LOG_LEVEL | default('info') }}
    steps:
      - run: |
          set -euo pipefail
          ./bin/migrate --url "$DATABASE_URL" --log "$LOG_LEVEL"
```

```sh
# .env.staging
DATABASE_URL=postgres://staging-db.internal/app
LOG_LEVEL=debug
```

```sh
zorb run migrate --env-file .env.staging
```

## Layering

`--env-file` populates the **inline env** layer, which sits at the bottom of the precedence stack:

```
inline CLI env  <  defaults.run.env  <  workflow env  <  task env  <  step env
```

So values in a dotenv become sensible defaults — anything the workflow declares at a higher scope overrides them.
Inline `-e KEY=VALUE` flags override `--env-file` values, so a CLI invocation can pin a single variable without
editing the file:

```sh
zorb run migrate --env-file .env.staging -e LOG_LEVEL=trace
```

## Per-environment files

Stash one dotenv per environment, gitignore the ones with secrets, commit the ones without:

```
.env.staging          # checked in
.env.production       # gitignored
.env.staging.local    # gitignored
```

Then wire each one to a task that targets that environment:

```sh
zorb run deploy --with environment=staging    --env-file .env.staging
zorb run deploy --with environment=production --env-file .env.production
```

If the choice is mechanical, push it into a wrapper task:

```yml
tasks:
  deploy-staging:
    steps:
      - uses: ./zorb.deploy
        with:
          environment: staging
```

…and call `zorb run deploy-staging --env-file .env.staging`.

## Secrets, not just config

`--env-file` is fine for non-secret config. For real credentials, prefer a `secrets:` loader that fetches at run time
and registers values through `context.setSecret`:

```yml
secrets:
  - uses: '@zorb/secrets/load-1password'
    with:
      vault: Production
      items: [DATABASE_URL, STRIPE_KEY]

tasks:
  migrate:
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
    steps:
      - run: ./bin/migrate
```

The difference: registered secrets are masked to `***` in step output. Values from `--env-file` are not.

## Dotenv syntax zorb supports

```
# Comments start with '#'
DATABASE_URL=postgres://localhost/app
LOG_LEVEL=debug              # inline comment after an unquoted value
export API_TOKEN=ghp_xxx     # 'export ' prefix is accepted, ignored
GREETING="hello\nworld"      # double quotes: \n \r \t \" \\ interpreted
LITERAL='no escapes here'    # single quotes: literal value
```

Blank lines and `#` lines are skipped. See [CLI reference → Env file format](../reference/cli.md#env-file-format) for
the precise rules.

## See also

- **[CLI reference → `zorb run`](../reference/cli.md#zorb-run-task)** — every flag in this recipe.
- **[Workflow format → Env](../reference/workflow.md#env)** — the precedence stack.
- **[Multi-environment deploy](./multi-environment-deploy.md)** — combines `--env-file` with `--with`.
