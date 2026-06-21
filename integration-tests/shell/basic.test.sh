#!/usr/bin/env bash
# Multi-step shell task with env-scope inheritance (workflow / task / step).
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

capture out err rc -- zorb run greet
assert_exit_code 0 "$rc"
assert_contains "$out" "step1 workflow=workflow task=task"
assert_contains "$out" "step2 step=step task=overridden"
