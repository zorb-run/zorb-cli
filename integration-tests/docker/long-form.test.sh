#!/usr/bin/env bash
# docker block — image + workdir + pull. Multi-line `run:` executes as a
# single shell invocation, so `pwd` and `echo` share state.
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

require_docker

capture out err rc -- zorb run long-form
assert_exit_code 0 "$rc"
assert_contains "$out" "/tmp"
assert_contains "$out" "long-form integration"
