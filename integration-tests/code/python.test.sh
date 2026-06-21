#!/usr/bin/env bash
# Python action via runners/runner.py. Skip locally if python3 missing; CI
# requires it (see lib.sh require_python3).
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

require_python3

capture out err rc -- zorb run greet-py
assert_exit_code 0 "$rc"
assert_contains "$err" "python greeted integration"
