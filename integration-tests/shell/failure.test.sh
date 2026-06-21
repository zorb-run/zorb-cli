#!/usr/bin/env bash
# A non-zero shell exit aborts the task and the subprocess exit code surfaces.
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

capture out err rc -- zorb run fail-middle
[[ "$rc" -ne 0 ]] || fail "expected non-zero exit, got 0"
assert_contains "$out" "first ran"
assert_not_contains "$out" "should not run"
