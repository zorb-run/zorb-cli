# zorb

## 0.1.2

### Patch Changes

- c011782: Fix documentation for NPM

## 0.1.1

### Patch Changes

- 4e1a7a1: Updated documentation for v0.1.1

## 0.1.0

### Minor Changes

- e0a679c: First documented release of `zorb`. The A-track core is feature-complete:

  - Shell, Docker, and code-action steps (JS, TS, CJS, MJS, Python)
  - Strict workflow validation with line/column-precise errors
  - `${{ }}` expression engine with operators, ternaries, and a starter filter set
  - Task inputs, secrets, env registration, and cross-file composition via `uses:`
  - Step controls — timeouts, retries, and clean signal handling
  - `zorb init` and `--watch` mode
  - Cross-compiled binaries for `darwin`/`linux` × `x64`/`arm64` published to NPM with provenance
  - End-to-end shell-script integration test suite

  Install with `npm install -g zorb`. Full guide and reference at <https://zorb.run>.

## 0.0.6

- feat(A1): Project scaffold by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/1
- feat(A2): YAML parsing and validation by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/2
- A3: Task inputs by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/3
- A4: Shell step execution by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/4
- A5: Expression engine by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/5
- feat(A6): secrets & env registration by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/6
- A7: defaults: support by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/7
- feat(A8): action step execution (uses: local) by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/8
- feat(A9): NPM action resolution (uses: packages) by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/9
- feat(A10): cross-file workflow references by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/10
- feat(A11): direct action execution (zorb use) by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/11
- feat(A12): step outputs by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/12
- feat(A13): docker step execution by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/13
- feat(A14): step timeouts, retries, and signal handling by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/14
- feat(A15): zorb init and --watch mode by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/15
- feat(A16): bundle compiled binaries for four platforms by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/16
- feat(A17): publish release binaries via GitHub Actions by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/17
- feat(A18): VitePress docs site by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/18
- feat(A19): extension-less uses, multi-match warning, guide pages by @jdrydn in
  https://github.com/zorb-run/zorb-cli/pull/19
- feat(A20): shell-script integration test suite by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/20
- fix: tighten CLI env model and --with surface by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/21
- docs: expand site with concepts, CLI, security, cookbook, CI guide by @jdrydn in
  https://github.com/zorb-run/zorb-cli/pull/22
- feat: accept zorb.yaml + modernise action examples by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/23
- feat(B1): expose `zorb/action` public type surface by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/24
- ci: changesets-driven release pipeline by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/25
- fix: Release by @jdrydn in https://github.com/zorb-run/zorb-cli/pull/26
- ci: version packages by @github-actions[bot] in https://github.com/zorb-run/zorb-cli/pull/27
