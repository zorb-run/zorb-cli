---
'zorb': minor
---

First documented release of `zorb`. The A-track core is feature-complete:

- Shell, Docker, and code-action steps (JS, TS, CJS, MJS, Python)
- Strict workflow validation with line/column-precise errors
- `${{ }}` expression engine with operators, ternaries, and a starter filter set
- Task inputs, secrets, env registration, and cross-file composition via `uses:`
- Step controls — timeouts, retries, and clean signal handling
- `zorb init` and `--watch` mode
- Cross-compiled binaries for `darwin`/`linux` × `x64`/`arm64` published to NPM with provenance
- End-to-end shell-script integration test suite

Install with `npm install -g zorb`. Full guide and reference at <https://zorb.run>.
