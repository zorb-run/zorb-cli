# Expressions

Zorb uses `${{ }}` as a template syntax for injecting dynamic values into workflow configuration. Expressions are resolved before a step executes.

## Where expressions work

Expressions are supported in `env:` values and `with:` inputs — everywhere you're passing data into a step or configuring the environment for one.

```yml
tasks:
  deploy:
    inputs:
      environment:
        type: string
        required: true
    env:
      TARGET: ${{ inputs.environment }}           # ✓ env: value
    steps:
      - uses: ./notify.action
        with:
          message: "Deploying to ${{ inputs.environment }}"   # ✓ with: value
      - run: echo "Deploying to $TARGET"          # ✓ $TARGET — native shell var
```

**`run:` strings are never interpolated.** They are passed to the shell verbatim. To use an expression result inside a shell command, map it to an env var first and read it natively:

```yml
env:
  MODE: ${{ inputs.dry-run ? 'dry-run' : 'apply' }}
steps:
  - run: echo "Running in $MODE mode"    # reads the env var, not an expression
```

This avoids two layers of substitution and keeps shell steps readable as plain scripts.

## Variables

### `inputs.<name>`

Refers to a task input resolved from `--with` flags or its declared default.

```yml
tasks:
  deploy:
    inputs:
      environment:
        type: string
        required: true
      dry-run:
        type: boolean
        default: false
    env:
      TARGET: ${{ inputs.environment }}
      DRY:    ${{ inputs.dry-run }}
```

Input names can contain hyphens (`inputs.dry-run`). Referencing an input that doesn't exist is an error.

### `env.<name>`

Refers to an environment variable in scope at the point of evaluation. The scope builds up in layers — process environment, then workflow-level `env:`, then task-level `env:` — so earlier layers are visible to later ones.

```yml
env:
  BASE_URL: https://example.com

tasks:
  ping:
    env:
      HEALTH_URL: ${{ env.BASE_URL }}/health    # BASE_URL is in scope here
    steps:
      - run: curl $HEALTH_URL
```

## Operators

### Equality: `==`, `!=`

Both sides are coerced to strings before comparison, so `true == 'true'` and `3 == '3'` both hold.

```yml
MODE: "${{ inputs.environment == 'prod' ? 'production' : 'staging' }}"
```

### Logical: `&&`, `||`, `!`

Short-circuit evaluation, same semantics as JavaScript: `&&` returns the first falsy value or the last value; `||` returns the first truthy value or the last value; `!` always returns a boolean.

```yml
env:
  SKIP: ${{ inputs.dry-run || inputs.no-deploy }}
  RUN:  ${{ !inputs.dry-run }}
```

Falsy values: `false`, `0`, empty string `''`. Everything else is truthy.

## Ternary

```
${{ condition ? value_if_true : value_if_false }}
```

```yml
env:
  TAG:  "${{ inputs.env == 'prod' ? 'latest' : inputs.env }}"
  MODE: "${{ inputs.dry-run ? 'dry-run' : 'apply' }}"
```

The condition can be any expression. Both branches are valid expressions too, including nested ternaries (though deeply nested ternaries are hard to read — prefer mapping inputs to env vars and using shell conditionals instead).

## Functions

Call a function directly or chain it as a filter with `|` (see [Filter syntax](#filter-syntax) below).

| Function | Signature | Description |
|---|---|---|
| `upper` | `upper(s)` | Uppercase string |
| `lower` | `lower(s)` | Lowercase string |
| `trim` | `trim(s)` | Strip leading and trailing whitespace |
| `replace` | `replace(s, from, to)` | Replace all occurrences of `from` with `to` |
| `contains` | `contains(s, needle)` | `true` if `s` contains `needle` |
| `startsWith` | `startsWith(s, prefix)` | `true` if `s` starts with `prefix` |
| `endsWith` | `endsWith(s, suffix)` | `true` if `s` ends with `suffix` |
| `length` | `length(s)` | Character count of `s` |
| `string` | `string(v)` | Convert any value to its string representation |
| `number` | `number(v)` | Parse a string to a number; errors if not numeric |
| `boolean` | `boolean(v)` | Convert to boolean; accepts `true/false`, `1/0`, `yes/no` |
| `default` | `default(v, fallback)` | Return `v` if non-empty, otherwise `fallback` |

```yml
env:
  UPPER_ENV:  ${{ upper(inputs.environment) }}
  SAFE_NAME:  ${{ replace(inputs.name, '/', '-') }}
  HAS_PREFIX: ${{ startsWith(inputs.tag, 'v') }}
  COUNT:      ${{ number(inputs.replicas) }}
```

## Filter syntax

Functions can be applied as filters using `|`. The value on the left becomes the first argument:

```
${{ value | fn }}           →  fn(value)
${{ value | fn(arg) }}      →  fn(value, arg)
```

Filters compose left-to-right:

```
${{ value | trim | lower }}    →  lower(trim(value))
```

This is particularly readable for transformation chains:

```yml
env:
  TAG:  ${{ inputs.version | trim | lower | replace('.', '-') }}
  NAME: ${{ inputs.name | default('anonymous') | upper }}
```

## Error behaviour

Referencing an undefined variable is always an error — there is no silent empty-string fallback. This catches typos early.

```yml
env:
  TARGET: ${{ inputs.environemnt }}   # error: undefined variable: inputs.environemnt
```

Referencing an unknown function or an unsupported namespace (`secrets.*`, `steps.*`) also errors with a message pointing to the milestone where support lands.

## Quoting in YAML

YAML parses `:` and `{` as structure characters in certain positions. Wrap any `${{ }}` value that might trigger this in double quotes:

```yml
env:
  OK:    ${{ inputs.env }}                         # fine — no special chars
  SAFE:  "${{ inputs.env == 'prod' ? 'a' : 'b' }}"  # quote when : appears
```
