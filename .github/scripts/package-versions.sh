#!/usr/bin/env bash
#
# The version contract for both packages -- one owner for every version field.
#
# WHY THIS EXISTS. v0.1.0 and v0.2.0 each published a `cake-autorate-3.2.2-r1.apk`
# and a `luci-app-cake-autorate-1.0.0-r1.apk` whose payloads DIFFERED. apk
# compares name-version-release, so a router already holding r1 is never offered
# r1 again: v0.2.0's changes could not reach anyone who installed v0.1.0, and
# nothing said so. Two different byte streams sharing one version string also
# poisons any future signed apk index. Nothing in the pipeline noticed, because
# both fields are hand-edited literals and the tag is deliberately not tied to
# either one.
#
# THE CONTRACT. The two packages number themselves differently, on purpose:
#
#   luci-app-cake-autorate   PKG_VERSION *is* the repo tag (minus the leading
#                            `v`); PKG_RELEASE is pinned at 1 forever. This
#                            package exists only in this repo -- there is no
#                            upstream to track -- so every release moves
#                            PKG_VERSION and the release counter has no work to
#                            do. That also makes it impossible to ship a changed
#                            payload under an unchanged version.
#
#   cake-autorate            PKG_VERSION tracks UPSTREAM lynxthecat/cake-autorate
#                            and is not ours to choose (see AGENTS.md: never bump
#                            it by hand -- Renovate owns it). PKG_RELEASE is
#                            therefore the only field that can distinguish two
#                            packagings of one upstream version, evaluated in
#                            this order:
#
#                              1. PKG_VERSION moved since the previous tag
#                                     -> PKG_RELEASE = 1        (reset)
#                              2. else net/cake-autorate/ changed since the
#                                 previous tag
#                                     -> PKG_RELEASE = previous + 1
#                              3. else
#                                     -> unchanged
#
# The ORDER matters. 3.2.3-r1 already sorts above 3.2.2-r7, because the upstream
# version dominates the comparison and the release is only a tiebreaker within
# it -- so an upstream bump RESETS. Incrementing there would discard the
# "packaging revisions of this upstream version" meaning of the field and buy
# nothing. Rule 1 winning over rule 2 is what makes the reset safe.
#
# Rule 2 is scoped to the PACKAGE DIRECTORY, not to "every tag". A LuCI-only,
# CI-only or docs-only release must NOT mint a new cake-autorate whose payload is
# byte-identical to the last one -- that offers every user an upgrade that
# changes nothing. (Rules 1+2 together are the algorithm behind OpenWrt's
# AUTORELEASE: count commits touching the package dir since PKG_VERSION last
# changed.)
#
# Rule 2 is deliberately imprecise in the HARMLESS direction: it counts any
# change under the package directory except the PKG_RELEASE line itself. Comments
# in files/*.sh genuinely do ship (v0.1.0 -> v0.2.0 was comment-only and still
# moved the payload by 556 bytes), but Makefile comments do not, so a
# comment-only Makefile edit bumps the release for an identical payload. Deciding
# which Makefile lines reach the output means parsing the Makefile; a spurious
# bump costs one pointless upgrade, while the miss it guards against costs a
# silent non-upgrade.
#
# TWO MODES, ONE ALGORITHM, so the fixer can never disagree with the check:
#
#   --fix    rewrite both Makefiles to the expected values. Run this when cutting
#            a release, review the one-line diff, commit, then tag.
#   (none)   assert, and on a mismatch fail with the value that was expected.
#            This is what release.yml's `validate` job runs, ahead of the SDK
#            build, so a wrong number costs seconds instead of a full build that
#            then refuses to publish.
#
# Expected values are computed from the PREVIOUS TAG's Makefiles, never from the
# working tree's. That makes the script idempotent: it converges on the same
# numbers however many times it runs, and however many PRs land between two tags.
#
# The values stay COMMITTED IN THE TREE -- never injected at build time -- so CI
# tests the exact version strings that ship, which is the property build.yml is
# built around.
#
# Requires full history and tags (actions/checkout `fetch-depth: 0`): every rule
# is relative to `git describe`.
#
# Usage:
#   .github/scripts/package-versions.sh [--fix] [--tag vX.Y.Z]
#
# The tag defaults to $GITHUB_REF_NAME (set for a tag push in Actions). Pass
# --tag when running locally, where the tag does not exist yet.

set -euo pipefail

CA_DIR="net/cake-autorate"
LUCI_DIR="luci/luci-app-cake-autorate"
CA_MK="$CA_DIR/Makefile"
LUCI_MK="$LUCI_DIR/Makefile"

die() {
	echo "error: $*" >&2
	exit 2
}

usage() {
	sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

fix=0
tag="${GITHUB_REF_NAME:-}"

while [ $# -gt 0 ]; do
	case "$1" in
	--fix) fix=1 ;;
	--tag)
		shift
		tag="${1:-}"
		;;
	--tag=*) tag="${1#--tag=}" ;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown argument: $1 (try --help)" ;;
	esac
	shift
done

[ -n "$tag" ] || die "no tag given: pass --tag vX.Y.Z (or set GITHUB_REF_NAME)"

# Same shape release.yml's `validate` step enforces. Checked here too so a local
# --fix run cannot write a nonsense version into a Makefile.
printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
	die "'$tag' is not vX.Y.Z or vX.Y.Z-suffix"

cd "$(git rev-parse --show-toplevel)"

for f in "$CA_MK" "$LUCI_MK"; do
	[ -f "$f" ] || die "missing $f (run from inside the repo)"
done

# Read `VAR:=value` out of a Makefile, insisting on exactly one definition -- a
# second one would mean the value this script reports is not the value make uses.
mk_get() { # mk_get <file> <var>
	local n
	n="$(grep -c "^$2:=" "$1" || true)"
	[ "$n" = "1" ] || die "$1: expected exactly one '$2:=' line, found $n"
	sed -n "s/^$2:=//p" "$1"
}

# Same, from a git revision rather than the worktree.
mk_get_rev() { # mk_get_rev <rev> <file> <var>
	local out
	out="$(git show "$1:$2" | sed -n "s/^$3:=//p")"
	[ -n "$out" ] || die "$1:$2 has no '$3:=' line"
	printf '%s\n' "$out"
}

mk_set() { # mk_set <file> <var> <value>
	sed -i "s|^$2:=.*|$2:=$3|" "$1"
}

# Did anything that affects the built package change since <rev>?
#
# The PKG_RELEASE line is excluded because it is this script's own output --
# counting it would make the rule self-satisfying (bump r, and the directory has
# "changed", which justifies the bump).
payload_changed() { # payload_changed <rev> <dir>
	local rev="$1" dir="$2"
	if ! git diff --quiet "$rev" -- "$dir" ":(exclude)$dir/Makefile"; then
		return 0
	fi
	if git diff -U0 "$rev" -- "$dir/Makefile" |
		grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' |
		grep -vqE '^[+-]PKG_RELEASE:='; then
		return 0
	fi
	return 1
}

# The tag exists in CI (we are building it) and does not exist locally (we are
# preparing it), so --exclude covers both: the previous tag is the newest tag
# reachable from HEAD that is not this one.
prev_tag="$(git describe --tags --abbrev=0 --exclude="$tag" HEAD 2>/dev/null || true)"

# --- luci-app-cake-autorate: PKG_VERSION == the tag, PKG_RELEASE pinned -------
#
# apk reserves `-r<digits>` for the release field, so a prerelease tag cannot
# carry its suffix as a dash: v0.3.0-rc1 would build
# luci-app-cake-autorate-0.3.0-rc1-r1.apk and leave apk to guess where the
# version ends. Translate to apk's own suffix spelling, which also sorts the way
# a prerelease should -- 0.3.0_rc1 is BELOW 0.3.0, not above it.
luci_want_version="${tag#v}"
luci_want_version="${luci_want_version//-/_}"
luci_want_release="1"

luci_have_version="$(mk_get "$LUCI_MK" PKG_VERSION)"
luci_have_release="$(mk_get "$LUCI_MK" PKG_RELEASE)"

# --- cake-autorate: upstream PKG_VERSION, PKG_RELEASE by the rules above ------
ca_have_version="$(mk_get "$CA_MK" PKG_VERSION)"
ca_have_release="$(mk_get "$CA_MK" PKG_RELEASE)"

if [ -z "$prev_tag" ]; then
	ca_want_release="$ca_have_release"
	ca_why="no previous tag to compare against -- left as-is"
else
	prev_ca_version="$(mk_get_rev "$prev_tag" "$CA_MK" PKG_VERSION)"
	prev_ca_release="$(mk_get_rev "$prev_tag" "$CA_MK" PKG_RELEASE)"

	if [ "$ca_have_version" != "$prev_ca_version" ]; then
		ca_want_release="1"
		ca_why="upstream PKG_VERSION moved ${prev_ca_version} -> ${ca_have_version} since ${prev_tag}: reset"
	elif payload_changed "$prev_tag" "$CA_DIR"; then
		ca_want_release="$((prev_ca_release + 1))"
		ca_why="${CA_DIR}/ changed since ${prev_tag} at the same upstream ${ca_have_version}: ${prev_ca_release} + 1"
	else
		ca_want_release="$prev_ca_release"
		ca_why="${CA_DIR}/ unchanged since ${prev_tag}: hold at ${prev_ca_release}"
	fi
fi

# --- report -------------------------------------------------------------------
printf '\n%-24s %-12s %-10s %-10s %s\n' package field current expected ""
printf '%-24s %-12s %-10s %-10s %s\n' ------- ----- ------- -------- ""

mismatch=0
row() { # row <package> <field> <have> <want>
	local status="ok"
	if [ "$3" != "$4" ]; then
		status="MISMATCH"
		mismatch=1
	fi
	printf '%-24s %-12s %-10s %-10s %s\n' "$1" "$2" "$3" "$4" "$status"
}

row cake-autorate PKG_VERSION "$ca_have_version" "$ca_have_version"
row cake-autorate PKG_RELEASE "$ca_have_release" "$ca_want_release"
row luci-app-cake-autorate PKG_VERSION "$luci_have_version" "$luci_want_version"
row luci-app-cake-autorate PKG_RELEASE "$luci_have_release" "$luci_want_release"

printf '\ntag           %s\n' "$tag"
printf 'previous tag  %s\n' "${prev_tag:-(none)}"
printf 'cake-autorate PKG_RELEASE: %s\n' "$ca_why"
printf 'luci-app-cake-autorate: PKG_VERSION follows the tag, PKG_RELEASE pinned at 1\n\n'

if [ "$mismatch" = "0" ]; then
	echo "Version contract satisfied for $tag."
	exit 0
fi

if [ "$fix" = "1" ]; then
	mk_set "$CA_MK" PKG_RELEASE "$ca_want_release"
	mk_set "$LUCI_MK" PKG_VERSION "$luci_want_version"
	mk_set "$LUCI_MK" PKG_RELEASE "$luci_want_release"
	echo "Rewrote the version fields for $tag. Review the diff, commit, then tag."
	git --no-pager diff -- "$CA_MK" "$LUCI_MK"
	exit 0
fi

# One annotation per wrong field, so the Actions log names the fix instead of
# leaving the maintainer to re-derive it from a table.
if [ "$ca_have_release" != "$ca_want_release" ]; then
	echo "::error title=Version contract::${CA_MK}: PKG_RELEASE is ${ca_have_release}, expected ${ca_want_release} (${ca_why})"
fi
if [ "$luci_have_version" != "$luci_want_version" ]; then
	echo "::error title=Version contract::${LUCI_MK}: PKG_VERSION is ${luci_have_version}, expected ${luci_want_version} (it follows the repo tag)"
fi
if [ "$luci_have_release" != "$luci_want_release" ]; then
	echo "::error title=Version contract::${LUCI_MK}: PKG_RELEASE is ${luci_have_release}, expected 1 (pinned: PKG_VERSION follows the tag)"
fi

cat >&2 <<EOF

Fix it with:

    .github/scripts/package-versions.sh --fix --tag $tag

then commit the result and re-tag. Publishing as-is would ship an .apk whose
filename collides with an earlier release's, and apk would not treat it as an
upgrade.
EOF
exit 1
