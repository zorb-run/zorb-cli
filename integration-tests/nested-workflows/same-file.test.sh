#!/usr/bin/env bash
# `uses: ./zorb.<task>` resolves to another task in the same file.
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

capture out err rc -- zorb run release
assert_exit_code 0 "$rc"
assert_contains "$out" "build ran"
assert_contains "$out" "release done"
