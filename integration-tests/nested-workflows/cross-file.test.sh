#!/usr/bin/env bash
# `uses: ./infra/zorb.<task>` resolves into a sibling workflow file, passing
# inputs through `with:`.
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

capture out err rc -- zorb run deploy
assert_exit_code 0 "$rc"
assert_contains "$out" "applying to production"
assert_contains "$out" "deploy done"
