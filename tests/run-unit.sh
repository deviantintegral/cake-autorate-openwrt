#!/bin/sh
#
# Runs every off-device unit suite. No VM, no KVM, no browser, no built .apk --
# just this checkout, so it is the one command to run before pushing and the
# first job CI runs.
#
# WHY A RUNNER AND NOT A LIST
#   The suites used to be enumerated in AGENTS.md prose and nowhere else. Prose
#   does not fail when it goes stale: the two node suites under
#   luci/luci-app-cake-autorate/tests/ were never listed and so were never run by
#   anyone, and CI had no unit job at all. That is how a graph-definition bug
#   shipped to a real router. So this DISCOVERS suites instead of naming them --
#   drop a new file into either location and it runs, with no second place to
#   remember to update.
#
#   Discovery rules:
#     tests/*/test-*.sh                          shell suites
#     luci/luci-app-cake-autorate/tests/*.test.js  node suites
#
#   The VM and Playwright suites are deliberately NOT matched: tests/integration
#   exposes run.sh (not test-*.sh) and needs QEMU + /dev/kvm, and tests/ui is
#   driven by playwright.config.js against a booted LuCI. Both have their own CI
#   jobs. See AGENTS.md "Running the tests + CI".
#
# A suite passes by exiting 0. Output is shown only for failures, so a green run
# stays readable; use --verbose to see all of it.
#
# EXIT: 0 if every suite passed, 1 otherwise.
#
# USAGE
#   tests/run-unit.sh              run everything
#   tests/run-unit.sh --list       print what would run, run nothing
#   tests/run-unit.sh --verbose    show output from passing suites too

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT" || exit 1

LIST_ONLY=0
VERBOSE=0
for arg in "$@"; do
	case "$arg" in
		--list)    LIST_ONLY=1 ;;
		--verbose) VERBOSE=1 ;;
		-h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*)         printf 'unknown argument: %s (try --help)\n' "$arg" >&2; exit 2 ;;
	esac
done

# --- discovery --------------------------------------------------------------
# Globs that match nothing expand to themselves in POSIX sh, hence the -e guard.

SHELL_SUITES=""
for f in tests/*/test-*.sh; do
	[ -e "$f" ] || continue
	SHELL_SUITES="$SHELL_SUITES $f"
done

NODE_SUITES=""
for f in luci/luci-app-cake-autorate/tests/*.test.js; do
	[ -e "$f" ] || continue
	NODE_SUITES="$NODE_SUITES $f"
done

# Glob rot would otherwise read as "everything passed". Refuse to be silent
# about discovering nothing: a moved directory must fail loudly, not vacuously.
if [ -z "$SHELL_SUITES" ]; then
	printf 'FAIL: discovered no shell suites matching tests/*/test-*.sh\n' >&2
	printf '      Did a directory move? This runner must not pass vacuously.\n' >&2
	exit 1
fi
if [ -z "$NODE_SUITES" ]; then
	printf 'FAIL: discovered no node suites matching luci/luci-app-cake-autorate/tests/*.test.js\n' >&2
	printf '      Did a directory move? This runner must not pass vacuously.\n' >&2
	exit 1
fi

HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1

if [ "$LIST_ONLY" -eq 1 ]; then
	printf 'shell suites:\n'
	for s in $SHELL_SUITES; do printf '  %s\n' "$s"; done
	printf 'node suites:%s\n' "$([ "$HAVE_NODE" -eq 1 ] || printf ' (node not installed -- would be SKIPped)')"
	for s in $NODE_SUITES; do printf '  %s\n' "$s"; done
	exit 0
fi

# --- run --------------------------------------------------------------------

PASSED=0
FAILED=0
SKIPPED=0
FAILED_NAMES=""

OUT=$(mktemp) || exit 1
# shellcheck disable=SC2064  # $OUT must expand now, not at trap time
trap "rm -f '$OUT'" EXIT INT TERM

run_suite() {
	# run_suite <label> <command...>
	label=$1
	shift
	printf '%-62s' "$label"
	if "$@" >"$OUT" 2>&1; then
		printf 'PASS\n'
		PASSED=$((PASSED + 1))
		[ "$VERBOSE" -eq 1 ] && sed 's/^/    | /' "$OUT"
	else
		rc=$?
		printf 'FAIL (exit %d)\n' "$rc"
		FAILED=$((FAILED + 1))
		FAILED_NAMES="$FAILED_NAMES $label"
		sed 's/^/    | /' "$OUT"
	fi
	return 0
}

printf 'Unit suites (no VM, no browser, no .apk)\n\n'

for s in $SHELL_SUITES; do
	run_suite "$s" sh "$s"
done

for s in $NODE_SUITES; do
	if [ "$HAVE_NODE" -eq 1 ]; then
		run_suite "$s" node "$s"
	else
		printf '%-62sSKIP (node not installed)\n' "$s"
		SKIPPED=$((SKIPPED + 1))
	fi
done

# --- summary ----------------------------------------------------------------

printf '\n'
if [ "$SKIPPED" -gt 0 ]; then
	printf 'NOTE: %d node suite(s) skipped -- install node to run them.\n' "$SKIPPED"
	printf '      CI installs node, so they are never skipped there.\n\n'
fi

if [ "$FAILED" -eq 0 ]; then
	printf 'PASS: %d/%d suites passed\n' "$PASSED" "$PASSED"
	exit 0
fi

printf 'FAIL: %d failed, %d passed\nfailed:\n' "$FAILED" "$PASSED"
for n in $FAILED_NAMES; do printf '  %s\n' "$n"; done
exit 1
