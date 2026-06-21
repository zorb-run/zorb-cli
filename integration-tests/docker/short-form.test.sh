#!/usr/bin/env bash
# docker: <image> short form, env passed through to the container.
set -euo pipefail
. "$(dirname "$0")/../lib.sh"

require_docker

capture out err rc -- zorb run short-form
assert_exit_code 0 "$rc"
assert_contains "$out" "container says hello"
