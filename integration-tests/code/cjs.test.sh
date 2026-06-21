#!/usr/bin/env bash
# CJS action runs via runners/runner.cjs, returns outputs, later shell step
# consumes them via env: mapping. Exercises the binary's runner discovery.
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

capture out err rc -- zorb run greet-cjs
assert_exit_code 0 "$rc"
# Action logs go to stderr (diagnostic channel).
assert_contains "$err" "action greeted integration"
# Shell step's stdout shows the consumed output.
assert_contains "$out" "shell saw hello integration"
