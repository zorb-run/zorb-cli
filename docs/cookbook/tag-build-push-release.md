# Tag, build, push a release

A release pipeline: derive the version from `package.json`, create a git tag, build the artefact, then push it
somewhere durable. Wires step outputs through three steps and uses one tiny action for the bit shell isn't great at
(JSON parsing).

## The shape

```yml
# zorb.yml
tasks:
  release:
    description: Cut a release from the current commit
    inputs:
      channel:
        description: NPM dist-tag (latest | next | beta)
        type: string
        default: latest
    steps:
      - id: version
        name: Read version from package.json
        uses: ./scripts/version.action
        with:
          path: ./package.json

      - name: Refuse to release a dirty tree
        run: |
          set -euo pipefail
          if [ -n "$(git status --porcelain)" ]; then
            echo "error: working tree has uncommitted changes" >&2
            git status --short >&2
            exit 1
          fi

      - id: tag
        name: Create and push the git tag
        env:
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          set -euo pipefail
          TAG="v$VERSION"
          if git rev-parse "$TAG" >/dev/null 2>&1; then
            echo "error: tag $TAG already exists" >&2
            exit 1
          fi
          git tag -a "$TAG" -m "Release $TAG"
          git push origin "$TAG"
          echo "tag=$TAG" >> "$ZORB_OUTPUT"

      - name: Build
        env:
          NODE_ENV: production
          VERSION: ${{ steps.version.outputs.version }}
        run: npm run build

      - name: Publish to npm
        env:
          TAG: ${{ steps.tag.outputs.tag }}
          CHANNEL: ${{ inputs.channel }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          set -euo pipefail
          echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > .npmrc
          npm publish --tag "$CHANNEL"
          echo "Published $TAG to channel $CHANNEL"
```

The action:

```ts
// scripts/version.action
import { readFileSync } from 'node:fs';

export function action(inputs: { path?: string }, context: { log: { info(m: string): void } }) {
  const path = inputs.path ?? 'package.json';
  const pkg = JSON.parse(readFileSync(path, 'utf-8'));
  context.log.info(`Detected version ${pkg.version}`);
  return { version: pkg.version, name: pkg.name };
}
```

Run it:

```sh
zorb run release
zorb run release --with channel=next
```

## Wiring outputs through the steps

The flow is:

1. `version.action` returns `{ version, name }`. The step's `id: version` makes those addressable via
   `${{ steps.version.outputs.version }}`.
2. The tag step reads the version into `$VERSION` and writes the resulting tag back to `$ZORB_OUTPUT`. The line
   `echo "tag=v$VERSION" >> "$ZORB_OUTPUT"` becomes `steps.tag.outputs.tag`.
3. The publish step picks up the tag from `${{ steps.tag.outputs.tag }}`.

Every cross-step value goes through `env:` first. `run:` strings are never interpolated — see
[Concepts → Expressions](../guide/concepts.md#expressions) for why.

## Failing fast

Two guard rails keep the task honest:

- **Dirty-tree check** — refuses to release if `git status --porcelain` shows anything. Cheap, prevents
  half-committed releases.
- **Tag collision check** — refuses if `git rev-parse "$TAG"` succeeds. Cheap, prevents accidental retags.

Both run before any side effect that touches the network. Failures exit non-zero, which fails the task — there's no
need for an `on-failure:` clause.

## Secrets, not env vars

`NPM_TOKEN` comes from `${{ secrets.NPM_TOKEN }}`, not `${{ env.NPM_TOKEN }}`. The difference matters: registered
secrets are masked to `***` in step output. If the publish step accidentally logs `--token=$NPM_TOKEN`, the token
won't leak into CI logs.

Wire a secrets loader at the top of the workflow:

```yml
secrets:
  - uses: '@zorb/secrets/load-1password'
    with:
      vault: Releases
      items: [NPM_TOKEN]
```

…or load it from a gitignored dotenv via a different loader. Either way, the workflow declares the dependency
explicitly.

## Retries on the publish step

`npm publish` is one of those steps that occasionally fails on a transient network error. Opt into retries with
exponential backoff:

```yml
- name: Publish to npm
  retries: 3
  backoff: exponential
  env:
    # …
  run: npm publish --tag "$CHANNEL"
```

zorb sleeps 1s, 2s, 4s between attempts. Three additional attempts on top of the first means up to four total — if
all four fail, the step fails the task.

## See also

- **[Reading values from `package.json`](./package-json-version.md)** — the `version.action` in full, with tests.
- **[Workflow format → Step outputs](../reference/workflow.md#step-outputs)** — the wire protocol behind `$ZORB_OUTPUT`.
- **[Concepts → Secrets](../guide/concepts.md#secrets)** — how `secrets.<name>` is built on top of actions.
