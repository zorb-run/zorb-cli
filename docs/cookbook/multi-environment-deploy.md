# Multi-environment deploy

One `deploy` task that targets any environment — staging, production, preview — driven entirely by `--with`. Keeps a
single source of truth instead of `deploy-staging` / `deploy-production` duplicates.

## The shape

```yml
# zorb.yml
tasks:
  deploy:
    description: Deploy to an environment
    inputs:
      environment:
        description: Target environment (staging | production)
        type: string
        required: true
      dry-run:
        description: Print the plan without applying it
        type: boolean
        default: false
    env:
      TARGET: ${{ inputs.environment }}
      MODE: ${{ inputs.dry-run ? 'dry-run' : 'apply' }}
      # Per-environment URL pulled from process env through the inline layer
      # (e.g. via `--env-file .env.<environment>` at the CLI).
      DEPLOY_URL: ${{ env.DEPLOY_URL }}
    steps:
      - name: Sanity-check the target
        run: |
          set -euo pipefail
          case "$TARGET" in
            staging|production) ;;
            *) echo "error: unknown environment '$TARGET'" >&2; exit 1 ;;
          esac

      - id: plan
        name: Plan
        uses: ./scripts/plan.action
        with:
          environment: ${{ inputs.environment }}
          url: ${{ env.DEPLOY_URL }}

      - name: Apply
        env:
          PLAN_ID: ${{ steps.plan.outputs.id }}
        run: |
          set -euo pipefail
          if [ "$MODE" = "dry-run" ]; then
            echo "skipping apply: dry-run mode"
            exit 0
          fi
          ./bin/deploy --plan "$PLAN_ID"
```

```sh
zorb run deploy --with environment=staging --env-file .env.staging
zorb run deploy --with environment=production dry-run=true --env-file .env.production
```

## Branching without `if:`

zorb has no `if:` step field — by design. The `Apply` step above demonstrates the pattern: put the branch inside the
script, gated on an env var that an expression resolved upstream. Shell `case` / `if` handles two or three branches
cleanly; past that, an action is the better tool because it's plain code instead of nested shell. See
[Creating code steps](../guide/creating-code-steps.md#code-step-or-shell-step).

## Routing per-environment config

Three places this lives, in order of preference:

1. **Per-environment `--env-file`** for values that change between environments (URLs, region, replicas).
2. **`--with`** for values the workflow needs to type-check (environment name, dry-run flag).
3. **`secrets:` loaders** for credentials. Never put credentials in `--env-file` committed to git.

A clean call site looks like:

```sh
zorb run deploy --with environment=production --env-file .env.production
```

## Wrapping the common cases

If you find yourself typing the same `--with` + `--env-file` combination repeatedly, hide it behind a thin wrapper
task. Wrappers are cheap — they're just `uses:` calls.

```yml
tasks:
  deploy-staging:
    description: Shortcut for `zorb run deploy --with environment=staging`
    steps:
      - uses: ./zorb.deploy
        with:
          environment: staging

  deploy-production:
    description: Shortcut for production
    steps:
      - uses: ./zorb.deploy
        with:
          environment: production
```

Cross-file refs work too — `uses: ./ops/zorb.deploy` calls a `deploy` task in `./ops/zorb.yml`. Useful when the app
workflow knows nothing about deployment plumbing.

## Listing what's available

`zorb list` shows tasks with their required inputs:

```
$ zorb list
zorb.yml

Tasks (3):
  deploy             Deploy to an environment
      environment    (string, required)  Target environment (staging | production)
  deploy-staging     Shortcut for `zorb run deploy --with environment=staging`
  deploy-production  Shortcut for production
```

Required inputs are visible at a glance, so a new contributor doesn't have to read the file to know what `--with` keys
the task expects.

## See also

- **[Loading env from a dotenv file](./load-env-from-dotenv.md)** — the `--env-file` half of this pattern.
- **[Composing tasks across files](./compose-across-files.md)** — split infra and app workflows.
- **[Workflow format → Inputs](../reference/workflow.md#inputs)** — the full input type system.
