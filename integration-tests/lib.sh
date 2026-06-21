# Shared helpers for integration tests.
#
# Each *.test.sh is invoked with `bash` from its own directory, with these
# variables exported by run.sh:
#   ZORB_BIN   — absolute path to the compiled zorb binary
#   TEST_NAME  — short test identifier (for messages)
#
# Conventions:
#   - `skip "<reason>"`  exits 77 — run.sh records the test as skipped.
#   - `fail "<reason>"`  exits 1  — run.sh records the test as failed.
#   - All assertions print expected/actual on failure so the diff is readable
#     in the run.sh summary.

set -euo pipefail

# Colour-free output regardless of host config.
export NO_COLOR=1

zorb() {
    "$ZORB_BIN" "$@"
}

skip() {
    printf 'SKIP: %s\n' "$*" >&2
    exit 77
}

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_exit_code() {
    local expected="$1" actual="$2"
    if [[ "$actual" != "$expected" ]]; then
        fail "expected exit code $expected, got $actual"
    fi
}

assert_contains() {
    local haystack="$1" needle="$2"
    if [[ "$haystack" != *"$needle"* ]]; then
        printf 'FAIL: expected output to contain %q\n--- actual ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
        exit 1
    fi
}

assert_not_contains() {
    local haystack="$1" needle="$2"
    if [[ "$haystack" == *"$needle"* ]]; then
        printf 'FAIL: expected output NOT to contain %q\n--- actual ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
        exit 1
    fi
}

assert_equals() {
    local expected="$1" actual="$2"
    if [[ "$actual" != "$expected" ]]; then
        printf 'FAIL: expected %q, got %q\n' "$expected" "$actual" >&2
        exit 1
    fi
}

# Capture a command's stdout, stderr, and exit code into named variables.
# Usage: capture out err rc -- zorb run hello
# Always returns 0 itself — caller asserts on $rc.
capture() {
    local out_var="$1" err_var="$2" rc_var="$3"
    shift 3
    [[ "$1" == "--" ]] && shift
    local _stdout_file _stderr_file _rc
    _stdout_file="$(mktemp)"
    _stderr_file="$(mktemp)"
    set +e
    "$@" >"$_stdout_file" 2>"$_stderr_file"
    _rc=$?
    set -e
    printf -v "$out_var" '%s' "$(cat "$_stdout_file")"
    printf -v "$err_var" '%s' "$(cat "$_stderr_file")"
    printf -v "$rc_var" '%s' "$_rc"
    rm -f "$_stdout_file" "$_stderr_file"
}

# Optional-tooling guards. Default behaviour is to skip cleanly when the tool
# is missing — that's what local contributors without docker/python want.
#
# Set ZORB_REQUIRE_DOCKER=1 or ZORB_REQUIRE_PYTHON=1 to flip a missing tool
# into a hard failure. CI sets these per-runner so coverage stays honest on
# platforms where the tool *should* be installed (Linux ships docker;
# macOS GitHub-hosted runners don't).
require_docker() {
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
        if [[ "${ZORB_REQUIRE_DOCKER:-}" == "1" ]]; then
            fail "docker required but unavailable (ZORB_REQUIRE_DOCKER=1)"
        fi
        skip "docker not available"
    fi
}

require_python3() {
    if ! command -v python3 >/dev/null 2>&1; then
        if [[ "${ZORB_REQUIRE_PYTHON:-}" == "1" ]]; then
            fail "python3 required but unavailable (ZORB_REQUIRE_PYTHON=1)"
        fi
        skip "python3 not installed"
    fi
}
