# Services for tests

Spin up Postgres (and friends) alongside a test run, wait for them to be ready, run the tests, then tear everything
down. GitHub Actions has a `services:` primitive for this; zorb doesn't — services are just shell steps wrapping
`docker run` or `docker compose`, plus the standard `zorb` machinery to thread env through.

Two flavours: **docker-compose** (recommended for anything past one service) and **direct `docker run`** (smallest
when one service is enough).

## With docker-compose

A `compose.test.yml` describes the services; `zorb.yml` orchestrates them.

```yml
# compose.test.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app_test
    ports: ['5432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U app']
      interval: 1s
      retries: 30

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 1s
      retries: 30
```

```yml
# zorb.yml
tasks:
  test:
    description: Run tests against ephemeral Postgres + Redis
    env:
      DATABASE_URL: postgres://app:app@localhost:5432/app_test
      REDIS_URL: redis://localhost:6379
    steps:
      - name: Start services
        run: docker compose -f compose.test.yml up --wait

      - name: Run tests
        run: npm test

      - name: Stop services
        run: docker compose -f compose.test.yml down --volumes
```

```sh
zorb run test
```

`--wait` blocks `docker compose up` until each service's healthcheck reports healthy. That removes the "sleep 5 and
hope" pattern entirely.

::: warning Cleanup on failure
If the test step fails, the workflow exits before `down` runs. Containers stay up. Two ways to handle it:

1. **Cleanup wrapper task.** Always call `down` as a fresh `zorb run test-down` from CI, regardless of test exit.
2. **Trap in the test step.** Combine setup + tests + teardown in one `run:` block with a shell trap so the
   teardown runs even when the test command fails:
   ```yml
   - run: |
       set -e
       trap 'docker compose -f compose.test.yml down --volumes' EXIT
       docker compose -f compose.test.yml up --wait
       npm test
   ```
   This trades clean step separation for guaranteed cleanup.
:::

## With a single `docker run`

If you only need one service and want zero compose-file overhead, `docker run -d` it directly:

```yml
tasks:
  test:
    description: Run tests against an ephemeral Postgres
    env:
      DATABASE_URL: postgres://test:test@localhost:5432/test
    steps:
      - id: start
        name: Start Postgres
        run: |
          set -euo pipefail
          CID=$(docker run -d --rm \
            -e POSTGRES_USER=test \
            -e POSTGRES_PASSWORD=test \
            -e POSTGRES_DB=test \
            -p 5432:5432 \
            postgres:16-alpine)
          echo "container=$CID" >> "$ZORB_OUTPUT"

      - name: Wait for Postgres
        env:
          CID: ${{ steps.start.outputs.container }}
        run: |
          for i in $(seq 1 30); do
            if docker exec "$CID" pg_isready -U test >/dev/null 2>&1; then
              echo "ready after ${i}s"; exit 0
            fi
            sleep 1
          done
          echo "Postgres did not become ready in 30s" >&2
          exit 1

      - name: Run tests
        run: npm test

      - name: Stop Postgres
        env:
          CID: ${{ steps.start.outputs.container }}
        run: docker stop "$CID" >/dev/null
```

Same trap-on-EXIT trick applies if you want guaranteed cleanup.

## Running tests inside a container too

The compose-and-shell pattern above runs tests on the host against services exposed on `localhost`. If your test
runner needs to be containerised (specific OS, specific tools, no host Node), use a `docker:` step for the test step
and put it on the same Docker network as the services:

```yml
# compose.test.yml — note the network
networks:
  default:
    name: zorb-test
```

```yml
# zorb.yml
tasks:
  test:
    env:
      DATABASE_URL: postgres://app:app@db:5432/app_test
      REDIS_URL: redis://redis:6379
    steps:
      - run: docker compose -f compose.test.yml up --wait

      - name: Run tests (containerised)
        docker:
          image: node:20-alpine
          network: zorb-test
          volumes:
            - ./:/app
          workdir: /app
        run: |
          set -euo pipefail
          npm ci
          npm test

      - run: docker compose -f compose.test.yml down --volumes
```

Two things change vs the host-runner case:

- **Service hostnames** are container names (`db`, `redis`), not `localhost`. The shared network resolves them.
- **The test container** needs the source tree, so the workflow mounts `./` into `/app`. No filesystem is mounted
  by default — see [Security model → Docker steps don't auto-mount](../reference/security.md#docker-steps-don-t-auto-mount).

## Per-environment overrides

Use `--with` to pick which compose file to target:

```yml
tasks:
  test:
    inputs:
      profile:
        description: 'unit | integration | e2e'
        type: string
        default: unit
    env:
      COMPOSE_FILE: compose.${{ inputs.profile }}.yml
    steps:
      - run: docker compose -f "$COMPOSE_FILE" up --wait
      - run: npm test
      - run: docker compose -f "$COMPOSE_FILE" down --volumes
```

```sh
zorb run test --with profile=integration
zorb run test --with profile=e2e
```

## Speeding up the loop

Two tweaks pay back almost immediately:

- **Pin image versions.** `postgres:16-alpine` not `postgres:latest`. Reproducibility plus image-pull caching.
- **Reuse the network across runs in dev.** `--wait` is cheap when the containers are already up. Use a separate
  `services-up` / `services-down` pair of tasks for dev iteration; let CI use the wrapper task that brings them
  up and down within a single `zorb run`.

```yml
tasks:
  services-up:
    steps:
      - run: docker compose -f compose.test.yml up -d --wait

  services-down:
    steps:
      - run: docker compose -f compose.test.yml down --volumes

  test-quick:
    description: Tests against already-running services (dev loop)
    env:
      DATABASE_URL: postgres://app:app@localhost:5432/app_test
    steps:
      - run: npm test
```

Then `zorb run services-up` once, iterate with `zorb run test-quick --watch 'src/**/*.{ts,tsx}'`, and tear down with
`zorb run services-down` when you're done.

## See also

- **[Workflow format → Docker steps](../reference/workflow.md#docker-steps)** — the field surface for `docker:`.
- **[Running zorb in CI](../guide/running-in-ci.md)** — how this recipe plugs into a GH Actions / GitLab job.
- **[Creating shell steps → Containerised commands](../guide/creating-shell-steps.md#containerised-commands)** —
  the `docker:` step from the workflow-author angle.
