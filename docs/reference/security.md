# Security model

What zorb's defaults protect against, what they don't, and how to compose a workflow that stays honest.

zorb is a local task runner — it executes whatever the workflow tells it to, on the developer's own machine. The
security story is about keeping that execution _bounded_: a workflow (or an action a workflow consumes) shouldn't be
able to quietly exfiltrate the developer's shell credentials, scrape host filesystems it wasn't given access to, or
mask its own behaviour from review.

## Threat model

The shapes zorb's defaults push back on:

1. **Casual credential scraping.** A careless or malicious action reads `process.env.AWS_SECRET_ACCESS_KEY` and POSTs
   it somewhere.
2. **Filesystem grazing.** A containerised step gets handed the whole repo by default and reads files it had no need
   for.
3. **Output leakage.** A workflow logs a secret value to stdout where it ends up in CI logs, terminal scrollback, or
   a saved tee.
4. **Silent ambiguity.** A `uses:` value matches two files on disk and the wrong one runs without anyone noticing.

What zorb does **not** try to defend against, by design:

- **Malicious workflows you authored.** `zorb.yml` is code; if it says `run: rm -rf ~`, zorb runs `rm -rf ~`.
- **Malicious actions you knowingly install.** Installing `@evil/loader` means you trust `@evil/loader`. zorb has no
  capability system, no signed-action store, no per-action permission grants.
- **Adversarial isolation.** zorb is not a sandbox. An action that wants to exfiltrate can shell out, open sockets,
  read files in `cwd`. The defaults raise the floor on accidents, not on attackers.

If you need adversarial isolation, run the workflow inside a VM or container with the network/filesystem scoped at
the OS level. zorb composes with those tools — it doesn't replace them.

## Strict, declaration-only env

The headline policy: **step subprocesses never inherit `process.env`**. Shell, docker, and action steps all start
from an env stack that's built entirely from declarations.

```
inline CLI env  <  defaults.run.env  <  workflow env  <  task env  <  step env
```

`defaults.run.env` applies to shell steps only. Everything else applies to all step kinds.

The **inline CLI env** is the only path from the calling shell into a step. It's built from:

- `--env-file <path>` — read the file, populate the layer.
- `-e KEY=VALUE` — set inline, overrides `--env-file`.
- `-e KEY` (no value) — copy `process.env[KEY]` into the layer. If `KEY` isn't set, the flag is silently skipped.

So if a step needs `GITHUB_TOKEN`, the workflow has to declare it or the caller has to pass `-e GITHUB_TOKEN`
explicitly. There is no implicit forwarding.

::: tip Why this is the default
The cost of strict env is that you have to declare what a step needs. The cost of permissive env (what most CI tools
do) is that any action with `process.env` access can read everything in the developer's shell — `SSH_AUTH_SOCK`,
`AWS_*`, browser session cookies, npm tokens, the lot. The trade favours strictness for a local-first tool where the
host happens to be a developer laptop.
:::

See [Concepts → Env, layered](../guide/concepts.md#env-layered) and [Workflow format → Env](./workflow.md#env) for
the full model.

## Secret masking

zorb has a small, deliberate secrets model: a run-scoped table of `(name, value)` pairs, populated by actions calling
`context.setSecret(name, value)`. Any exact-substring match of a registered value in step output is replaced with
`***` before it reaches the terminal.

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

```
> Step 1/1: ./bin/migrate
Connecting to ***
Migration complete.
```

### What is masked

| Step kind         | stdout / stderr masked?              |
| ----------------- | ------------------------------------ |
| Shell (`run:`)    | **Yes** — piped through the mask.    |
| Docker (`run:` + `docker:`) | **Yes** — piped through the mask. |
| Action (`uses:` → file/NPM) | **No** — inherited directly to the terminal. |

The action gap is the one to internalise: **action stdout/stderr is not masked.** An action that calls
`context.log.info(secretValue)` (or just `console.log(secretValue)`) will print the value in the clear. The reason is
plumbing — action subprocesses inherit the parent's stdio so their logging arrives in real time without buffering;
piping through a masker would cost that.

The mitigation: **don't log secrets from action code.** Log derived metadata if you need to (token length, expiry,
fingerprint) but never the secret itself. Treat the runner's log helpers like you'd treat `console.log` in any other
codebase that handles credentials.

### Limits of substring masking

The mask is literal substring replacement, not a semantic redactor. It misses anything the workflow transforms:

- `base64 -d <<< "$TOKEN"` — the decoded form isn't in the secret table.
- `echo "${TOKEN:0:8}…"` — the truncation isn't matched.
- `urlencode "$TOKEN"` — percent-encoded characters won't match.

If a step needs to log a transformed version of a credential, transform it _before_ registering it as a secret, or
log non-value metadata instead.

### First-write-wins

`setSecret(name, value)` only accepts a value the first time it's called for a given name. Subsequent calls for the
same name are no-ops and emit a warning. This stops a later loader (or a tampered downstream action) from quietly
replacing a credential with a different one.

## Docker steps don't auto-mount

A `docker:` step starts a container with **no host filesystem mounted**, except for the `$ZORB_OUTPUT` file (so step
outputs work). The workflow opts into directory access explicitly:

```yml
- name: Run migrations
  docker:
    image: postgres:16-alpine
    volumes:
      - ./migrations:/migrations    # explicit, opt-in
    workdir: /migrations
  run: psql "$DATABASE_URL" -f schema.sql
```

This is the standard pattern in tools that take filesystem isolation seriously (docker-compose, devcontainers).
zorb's contribution is making the default _restrictive_ — the container can't see the source tree unless the workflow
declares the mount.

## Strict workflow validation

The parser runs before any step does. It rejects:

- Unknown top-level / task / step / input keys (with a "did you mean" hint for typos).
- Wrong types (`steps: 'oops'` when a sequence was expected).
- Duplicate step IDs within a task.
- A step with both `run:` and `uses:`.
- `uses:` values with a runtime extension (`./scripts/x.action.ts`) — drops the source-of-truth ambiguity.
- Cycles in cross-file workflow refs.

A workflow that mis-spells `secret_keys` as `secret-keys` is caught at validation time, not when a secret is later
missing from the table.

## `uses:` resolution is explicit

The resolver tries each known runtime extension in order — `.ts → .mjs → .cjs → .js → .py` — and prints a warning if
more than one matches the same logical path. So a stale `greet.action.js` next to a freshly authored `greet.action.ts`
doesn't silently shadow the newer file; the warning names both, and the developer chooses which to keep.

NPM action resolution walks up from the workflow directory using Node's standard `node_modules` lookup. Missing
`@zorb/*` packages produce an install hint rather than a generic "module not found" — so a typo in `@zorb/aws` doesn't
fall through to "did the developer forget to install something?" by accident.

## Subprocess boundaries

Every step is a fresh subprocess:

- **Shell steps** spawn `$SHELL -c <string>`. The string is **never** interpolated by zorb — it's passed verbatim, so
  `${{ }}` expressions can't smuggle YAML-time content into shell-time interpretation.
- **Docker steps** spawn `docker run …` with the requested image, volumes, network, and workdir. Same verbatim
  argument handling.
- **Action steps** spawn `<runtime> runner.{cjs,py} <action.path> action <input.json> <result.json>`. Inputs and the
  context object are passed as JSON via a temp file; outputs come back the same way. There is no shared filesystem
  between the orchestrator and the runner beyond `cwd`, the explicitly-passed env, and the two temp files.
- **Cross-file workflow refs** are _not_ subprocesses — they're invoked by zorb's own runner — but they still see
  only the inputs you pass via `with:`. Caller `inputs` do not bleed into the callee.

The temp files for action invocations are written into `os.tmpdir()` under a `zorb-action-<random>/` directory and
removed in a `finally` block after the step finishes, regardless of exit status.

## Recommendations

The short list of habits that compound:

1. **Load secrets through a loader, not `--env-file`.** Loaders register values via `setSecret`, which puts them into
   the mask table. `--env-file` doesn't. If a credential reaches a step via `--env-file`, it won't be masked in
   output.
2. **Audit any action before adding it to `uses:`.** Same standard as adding a dependency. NPM actions can do
   anything an NPM package can do — read the source first.
3. **Pin NPM actions to a specific version.** Use `package.json` to lock the version of `@zorb/aws`,
   `@zorb/slack`, etc. Floating tags get you supply-chain surprises.
4. **Don't log secrets from action code.** Action stdout/stderr is not masked. If you must surface a credential's
   shape (length, expiry, prefix), log _that_, not the value.
5. **Pass credentials with `-e KEY`, not `-e KEY=VALUE` baked into a script.** `-e KEY` forwards the current process
   value and leaves no trace in shell history.
6. **Don't run untrusted workflows.** A `zorb.yml` that came from a stranger is code; treat it the same way you'd
   treat `npm install` from a stranger.
7. **Compose with OS-level isolation for adversarial cases.** If the workflow needs to run something genuinely
   untrusted, wrap the whole `zorb run` in a container, a VM, or a separate user account. zorb composes; it doesn't
   replace.

## See also

- **[Concepts → Env, layered](../guide/concepts.md#env-layered)** — the env precedence stack.
- **[Concepts → Secrets](../guide/concepts.md#secrets)** — the secret table from the workflow author's perspective.
- **[Workflow format → Env](./workflow.md#env)** — the precise rules in reference form.
- **[Writing actions → Environment](../guide/actions.md#environment)** — the same model from the action author's
  perspective.
- **[Troubleshooting → My secret isn't masked in the output](../guide/troubleshooting.md#my-secret-isn-t-masked-in-the-output)** — the common cause.
