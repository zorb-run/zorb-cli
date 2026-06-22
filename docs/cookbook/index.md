# Cookbook

Worked recipes for common workflow shapes. Each one is a small, complete example you can paste into a `zorb.yml` and
adapt. Pick the closest fit; the comments call out the parts most likely to need changing.

## Recipes

- **[Loading env from a dotenv file](./load-env-from-dotenv.md)** — point `--env-file` at a per-environment dotenv,
  layer task-specific env on top.
- **[Multi-environment deploy](./multi-environment-deploy.md)** — one `deploy` task that targets staging or production
  via `--with environment=…`.
- **[Tag, build, push a release](./tag-build-push-release.md)** — a release pipeline that derives the version from
  `package.json`, tags git, builds, then publishes.
- **[Composing tasks across files](./compose-across-files.md)** — split infra and app workflows; call infra from app
  via `uses: ./infra/zorb.<task>`.
- **[Reading values from `package.json`](./package-json-version.md)** — a tiny TypeScript action that extracts the
  version (and anything else) for downstream steps.
- **[Services for tests](./services-for-tests.md)** — spin up Postgres and Redis for an integration-test run, then
  tear them down. Covers docker-compose and direct `docker run` shapes.

## When to reach for a recipe

These exist because the same shapes come up over and over. If you find yourself reaching for the same pattern more
than twice, look here first — odds are it's already written down. If it isn't, the
[`examples/`](https://github.com/zorb-run/zorb-cli/tree/main/examples) directory in the repo has more, and the
[CONTRIBUTING guide](https://github.com/zorb-run/zorb-cli/blob/main/CONTRIBUTING.md) has notes on adding new ones.
