#!/usr/bin/env bash
# Integration test harness.
#
# Discovers every *.test.sh under integration-tests/, runs each in its own
# directory against the compiled zorb binary, and tallies pass / fail / skip.
#
# Usage:
#   ./integration-tests/run.sh                        # run all
#   ./integration-tests/run.sh shell/basic.test.sh    # run a subset (paths
#                                                     # are relative to
#                                                     # integration-tests/)
#
# The compiled binary must already exist. We don't auto-build because (a) the
# build belongs to its own step in CI and (b) silently rebuilding hides the
# wrong-binary class of bug. Build it explicitly first:
#
#   bun scripts/build.ts --current
#
# Environment:
#   ZORB_BIN    Override the binary path. Default: dist/<host>/zorb under the
#               repo root, where <host> is derived from `uname`.
#   CI          When 'true', tests that would otherwise skip (docker, python3)
#               hard-fail instead — keeps coverage honest on Linux runners.

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# --- locate the binary -------------------------------------------------------
#
# Detection mirrors scripts/build.ts `currentPlatform()` and bin/zorb.cjs so all
# three agree on what `<host>` means. Keep the mappings in sync if you add a
# new target.

detect_host() {
    local os arch_raw arch
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch_raw="$(uname -m)"
    case "$os" in
        darwin|linux) ;;
        *) printf 'unsupported host OS: %s\n' "$os" >&2; exit 2 ;;
    esac
    case "$arch_raw" in
        aarch64|arm64) arch=arm64 ;;
        x86_64|amd64)  arch=x64 ;;
        *) printf 'unsupported host arch: %s\n' "$arch_raw" >&2; exit 2 ;;
    esac
    printf '%s-%s\n' "$os" "$arch"
}

if [[ -z "${ZORB_BIN:-}" ]]; then
    HOST="$(detect_host)"
    ZORB_BIN="$REPO_ROOT/dist/$HOST/zorb"
fi

if [[ ! -x "$ZORB_BIN" ]]; then
    printf 'zorb binary not found at %s\n' "$ZORB_BIN" >&2
    printf 'build it first:  bun scripts/build.ts --current\n' >&2
    exit 2
fi
export ZORB_BIN

# --- discover tests ----------------------------------------------------------

tests=()
if [[ $# -gt 0 ]]; then
    for arg in "$@"; do
        path="$HARNESS_DIR/$arg"
        if [[ ! -f "$path" ]]; then
            printf 'no such test: %s\n' "$arg" >&2
            exit 2
        fi
        tests+=("$path")
    done
else
    while IFS= read -r -d '' f; do
        tests+=("$f")
    done < <(find "$HARNESS_DIR" -type f -name '*.test.sh' -print0 | sort -z)
fi

if [[ ${#tests[@]} -eq 0 ]]; then
    printf 'no tests found under %s\n' "$HARNESS_DIR" >&2
    exit 0
fi

# --- run ---------------------------------------------------------------------

pass=0
fail=0
skip=0
failed_names=()
skipped_names=()

printf 'binary: %s\n' "$ZORB_BIN" >&2
printf 'tests:  %d\n\n' "${#tests[@]}" >&2

for test_file in "${tests[@]}"; do
    rel="${test_file#$HARNESS_DIR/}"
    test_dir="$(dirname "$test_file")"
    test_name="${rel%.test.sh}"

    printf '> %s ... ' "$rel"

    output_file="$(mktemp)"
    set +e
    (
        cd "$test_dir"
        TEST_NAME="$test_name" bash "$test_file"
    ) >"$output_file" 2>&1
    rc=$?
    set -e

    case "$rc" in
        0)
            printf 'ok\n'
            pass=$((pass + 1))
            ;;
        77)
            printf 'skip\n'
            skip=$((skip + 1))
            skipped_names+=("$rel")
            # surface the SKIP reason inline so contributors know what's missing
            if grep -q '^SKIP:' "$output_file"; then
                sed -n 's/^SKIP: /    /p' "$output_file"
            fi
            ;;
        *)
            printf 'FAIL (exit %d)\n' "$rc"
            fail=$((fail + 1))
            failed_names+=("$rel")
            sed 's/^/    /' "$output_file"
            ;;
    esac
    rm -f "$output_file"
done

# --- summary -----------------------------------------------------------------

total=$((pass + fail + skip))
printf '\n%d total | %d ok | %d fail | %d skip\n' "$total" "$pass" "$fail" "$skip"

if [[ $skip -gt 0 ]]; then
    printf '\nskipped:\n'
    for n in "${skipped_names[@]}"; do printf '  - %s\n' "$n"; done
fi

if [[ $fail -gt 0 ]]; then
    printf '\nfailed:\n'
    for n in "${failed_names[@]}"; do printf '  - %s\n' "$n"; done
    exit 1
fi
