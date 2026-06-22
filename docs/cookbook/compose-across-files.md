# Composing tasks across files

When a single `zorb.yml` starts feeling crowded — typically once a project has its own deployment plumbing — split
the workflow across files and use `uses:` to call between them. zorb composes tasks call-style; there's no DAG, no
`needs:`, just function calls.

## The shape

A project with a root workflow for app tasks and an `ops/` workflow for deployment plumbing:

```
.
├── zorb.yml              # build, test, release
├── ops/
│   └── zorb.yml          # plan, apply, rollback
└── infra/
    └── zorb.yml          # tf plan, tf apply
```

Root workflow:

```yml
# zorb.yml
tasks:
  build:
    description: Build the project
    steps:
      - run: npm run build

  release:
    description: Build and deploy to production
    steps:
      - uses: ./zorb.build                # same-file ref
      - uses: ./ops/zorb.apply            # cross-file ref
        with:
          environment: production
```

Ops workflow:

```yml
# ops/zorb.yml
tasks:
  plan:
    description: Print the changes a deploy would make
    inputs:
      environment:
        type: string
        required: true
    steps:
      - uses: ../infra/zorb.plan
        with:
          workspace: ${{ inputs.environment }}

  apply:
    description: Roll a build out to an environment
    inputs:
      environment:
        type: string
        required: true
    steps:
      - uses: ./zorb.plan                 # task in this same file
        with:
          environment: ${{ inputs.environment }}
      - uses: ../infra/zorb.apply
        with:
          workspace: ${{ inputs.environment }}
          auto-approve: true
```

Run it from the project root:

```sh
zorb run release                                  # build + apply production
zorb --file ops/zorb.yml run plan --with environment=staging
```

## How the resolver finds the other file

`uses: ./[dir/]zorb.<task>` is the cross-file form. zorb spots it by the `zorb.` basename: anything else
is either an action file or an NPM action.

- The path is relative to the **calling workflow's directory**, not the CLI's `cwd`. So `uses: ../infra/zorb.plan`
  from `ops/zorb.yml` reaches `infra/zorb.yml` correctly even when you ran `zorb run release` from the project root.
- The taskname after `zorb.` cannot contain dots — `zorb.deploy.staging` is invalid (it's parsed as a workflow ref to
  a malformed task name).
- Cycles are detected at runtime and error. `A` calling `B` calling `A` produces a clear cycle message before any
  step runs.

See [Workflow format → Resolution](../reference/workflow.md#resolution) for the precise resolution order.

## What the callee sees

A cross-file task is **not** a subprocess — it's invoked by zorb's own runner. But it's still isolated:

- **Inputs are explicit.** The callee only sees the keys you pass via `with:`. The caller's `inputs` do not bleed
  through. If the deploy task needs to know which environment, you pass `with: { environment: … }`.
- **Env layers reset.** The callee's `env:` stack starts from the workflow's `env:`, just like an outer `zorb run`
  would. Inline CLI env (`--env-file`, `-e`) flows through because it's set at the process level.
- **Secrets table is shared.** Pre-task secrets loaded by the outer workflow remain visible to the inner one.

So a cross-file call is closer to "function call with explicit arguments" than "subprocess." Outputs from the
callee's steps stay inside the callee — they don't surface in the caller.

## When to split

Rough heuristics:

- **Same domain, same lifecycle** → keep it in one file. `build`, `test`, `lint` belong together.
- **Different lifecycle or owner** → split. Application code vs. infrastructure rollout. Local dev vs. CI-only tasks.
  Splitting makes the boundary explicit and gives each side its own `env:`, `defaults:`, and `secrets:` block.
- **Different blast radius** → split. The release workflow that pushes to npm shouldn't share a directory with the
  smoke-test workflow.

If splitting feels premature, it probably is. One `zorb.yml` with eight tasks is fine.

## Calling a sibling task from the same file

The same `./zorb.<task>` syntax works for tasks in the calling file:

```yml
tasks:
  build:
    steps:
      - run: npm run build

  release:
    steps:
      - uses: ./zorb.build           # this same file
      - run: ./scripts/push.sh
```

Useful when a task wants to be callable on its own _and_ used as a step elsewhere. The alternative — copy-pasting
steps — drifts the moment one side changes.

## See also

- **[Multi-environment deploy](./multi-environment-deploy.md)** — drives a cross-file deploy task with `--with`.
- **[Concepts → Three kinds of step](../guide/concepts.md#three-kinds-of-step)** — where workflow refs sit in the
  step model.
- **[Workflow format → Resolution](../reference/workflow.md#resolution)** — the exact rule the resolver applies.
