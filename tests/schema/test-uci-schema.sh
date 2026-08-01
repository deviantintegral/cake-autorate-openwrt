#!/bin/sh
#
# test-uci-schema.sh -- tests the UCI schema without needing a router.
#
# It checks that:
#   1. the shipped /etc/config/cake-autorate is valid UCI grammar;
#   2. it covers exactly the 66 upstream options in
#      docs/upstream-option-inventory.md -- nothing missing, nothing invented
#      (one unknown key kills the daemon: see inventory section 2.2);
#   3. the schema metadata (docs/uci-option-schema.tsv) agrees with the
#      inventory on names and types, and with the shipped config on values;
#   4. every default is written in a form upstream accepts -- floats carry a
#      decimal point, integers do not, bools are 0/1, and the three
#      must-not-be-empty strings are non-empty (inventory section 2.3);
#   5. two named sections can coexist with no shared/global section and no
#      unknown keys.
#
# `uci import` / `uci show` are not run here, since libuci is not present on a
# build host; the VM harness covers that on-device.
#
# Usage:
#   tests/schema/test-uci-schema.sh [--upstream /path/to/defaults.sh]
#
# With --upstream, the inventory and the metadata are additionally diffed
# against the real upstream defaults.sh at the pinned tag.
#
# Exit 0 = all checks passed.

set -u

here=$(dirname "$0")
root=$(cd "$here/../.." && pwd)

CONFIG="$root/net/cake-autorate/files/cake-autorate.config"
TSV="$root/docs/uci-option-schema.tsv"
INVENTORY="$root/docs/upstream-option-inventory.md"
FIXTURE="$root/tests/schema/fixtures/two-instances.uci"
PARSER="$here/uci-syntax-check.awk"

# UCI keys that are package-local (procd/LuCI bookkeeping) and must NEVER be
# emitted into the generated shell config.
PACKAGE_LOCAL_KEYS="enabled"

# Upstream string options whose default is non-empty: setting them empty is a
# fatal config error upstream (inventory section 2.3).
NONEMPTY_STRINGS="dl_if ul_if pinger_binary"

UPSTREAM_DEFAULTS=""
while [ $# -gt 0 ]; do
	case "$1" in
		--upstream) UPSTREAM_DEFAULTS="${2:-}" ; shift 2 ;;
		*) echo "unknown argument: $1" >&2 ; exit 2 ;;
	esac
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

fails=0
checks=0

ok()   { checks=$((checks+1)); printf 'ok   %s\n' "$*"; }
fail() { checks=$((checks+1)); fails=$((fails+1)); printf 'FAIL %s\n' "$*"; }

# ---------------------------------------------------------------- check 1
echo "== 1. required files exist"
for f in "$CONFIG" "$TSV" "$INVENTORY" "$FIXTURE" "$PARSER"; do
	if [ -f "$f" ]; then ok "present: ${f#"$root"/}"; else fail "missing: ${f#"$root"/}"; fi
done
[ "$fails" -eq 0 ] || { echo; echo "$fails/$checks checks FAILED"; exit 1; }

# ---------------------------------------------------------------- check 2
echo
echo "== 2. UCI grammar"
for f in "$CONFIG" "$FIXTURE"; do
	base=$(basename "$f")
	if awk -f "$PARSER" "$f" > "$tmp/$base.parsed" 2> "$tmp/$base.err"; then
		ok "parses as UCI: ${f#"$root"/}"
	else
		fail "UCI syntax errors in ${f#"$root"/}"
		sed 's/^/       /' "$tmp/$base.err"
	fi
done

parsed_config="$tmp/$(basename "$CONFIG").parsed"
parsed_fixture="$tmp/$(basename "$FIXTURE").parsed"

# ---------------------------------------------------------------- check 3
echo
echo "== 3. section shape (named instance sections, no global/anonymous section)"
for p in "$parsed_config" "$parsed_fixture"; do
	src=$(basename "$p" .parsed)
	bad_type=$(awk -F'\t' '$1=="section" && $2!="cake-autorate" {print $2}' "$p")
	if [ -z "$bad_type" ]; then
		ok "$src: every section is of type 'cake-autorate'"
	else
		fail "$src: unexpected section type(s): $bad_type"
	fi

	anon=$(awk -F'\t' '$1=="section" && $3=="" {c++} END{print c+0}' "$p")
	if [ "$anon" -eq 0 ]; then
		ok "$src: no anonymous section (every instance is named)"
	else
		fail "$src: $anon anonymous section(s) -- instance id comes from the section name"
	fi

	names=$(awk -F'\t' '$1=="section" {print $3}' "$p")
	dupes=$(printf '%s\n' "$names" | sort | uniq -d)
	if [ -z "$dupes" ]; then
		ok "$src: instance names unique"
	else
		fail "$src: duplicate instance name(s): $dupes"
	fi

	# every section must carry the procd gate
	missing_enabled=$(awk -F'\t' '
		$1=="section" { if (cur != "" && !seen) print cur; cur=$3; seen=0 }
		$1=="option" && $2=="enabled" { seen=1 }
		END { if (cur != "" && !seen) print cur }' "$p")
	if [ -z "$missing_enabled" ]; then
		ok "$src: every instance carries an 'enabled' flag"
	else
		fail "$src: section(s) without 'enabled': $missing_enabled"
	fi
done

# ------------------------------------------------------------ key extraction
# Inventory option names, in the order the section 4 table lists them.
awk -F'|' '
	NF >= 8 {
		num=$2; name=$3
		gsub(/[ \t]/, "", num)
		gsub(/[ \t`]/, "", name)
		if (num ~ /^[0-9]+$/ && name ~ /^[A-Za-z_][A-Za-z0-9_]*$/) print name
	}' "$INVENTORY" > "$tmp/inventory.names"

# Inventory types, same order, renamed to match the schema's own type names.
awk -F'|' '
	NF >= 8 {
		num=$2; name=$3; type=$4
		gsub(/[ \t]/, "", num)
		gsub(/[ \t`]/, "", name)
		gsub(/^[ \t]+|[ \t]+$/, "", type)
		if (num !~ /^[0-9]+$/ || name !~ /^[A-Za-z_][A-Za-z0-9_]*$/) next
		if (type == "integer (bool)") type = "bool"
		else if (type == "array") type = "list"
		print name "\t" type
	}' "$INVENTORY" > "$tmp/inventory.types"

# Metadata columns.
awk -F'\t' '$0 !~ /^#/ && NF > 0 {print $2}' "$TSV" > "$tmp/tsv.upstream"
awk -F'\t' '$0 !~ /^#/ && NF > 0 {print $1}' "$TSV" > "$tmp/tsv.uci"
awk -F'\t' '$0 !~ /^#/ && NF > 0 {print $2 "\t" $3}' "$TSV" > "$tmp/tsv.types"

# UCI keys actually present in the shipped default config (package-local keys
# stripped -- they are not upstream options).
awk -F'\t' -v local="$PACKAGE_LOCAL_KEYS" '
	BEGIN { n=split(local, a, " "); for (i=1;i<=n;i++) skip[a[i]]=1 }
	($1=="option" || $1=="list") && !($2 in skip) { print $2 }' "$parsed_config" \
	| sort -u > "$tmp/config.keys"

# ---------------------------------------------------------------- check 4
echo
echo "== 4. metadata field shape"
badcols=$(awk -F'\t' '$0 !~ /^#/ && NF > 0 && NF != 10 {print NR ": " NF " fields"}' "$TSV")
if [ -z "$badcols" ]; then
	ok "every metadata row has exactly 10 tab-separated columns"
else
	fail "malformed metadata row(s):"; printf '       %s\n' "$badcols"
fi

n_tsv=$(wc -l < "$tmp/tsv.upstream" | tr -d ' ')
n_inv=$(wc -l < "$tmp/inventory.names" | tr -d ' ')
if [ "$n_inv" -eq 66 ]; then ok "inventory yields 66 option rows"; else fail "inventory yields $n_inv option rows, expected 66"; fi
if [ "$n_tsv" -eq 66 ]; then ok "metadata yields 66 option rows"; else fail "metadata yields $n_tsv option rows, expected 66"; fi

# ---------------------------------------------------------------- check 5
echo
echo "== 5. every option list agrees with every other"
if diff -u "$tmp/inventory.names" "$tmp/tsv.upstream" > "$tmp/d1"; then
	ok "inventory option list == metadata upstream_option list (same names, same order)"
else
	fail "inventory vs metadata upstream_option differ:"; sed 's/^/       /' "$tmp/d1"
fi

sort -u "$tmp/tsv.uci" > "$tmp/tsv.uci.sorted"
if diff -u "$tmp/tsv.uci.sorted" "$tmp/config.keys" > "$tmp/d2"; then
	ok "metadata uci_option set == UCI keys in the shipped config (no missing, no extraneous)"
else
	fail "metadata vs shipped UCI config differ:"; sed 's/^/       /' "$tmp/d2"
fi

sort -u "$tmp/inventory.names" > "$tmp/inventory.sorted"
if diff -u "$tmp/inventory.sorted" "$tmp/config.keys" > "$tmp/d3"; then
	ok "inventory option set == UCI keys in the shipped config (empty diff)"
else
	fail "inventory vs shipped UCI config differ:"; sed 's/^/       /' "$tmp/d3"
fi

# No file anywhere may use a key outside inventory + package-local.
for p in "$parsed_config" "$parsed_fixture"; do
	src=$(basename "$p" .parsed)
	unknown=$(awk -F'\t' -v local="$PACKAGE_LOCAL_KEYS" '
		BEGIN { n=split(local, a, " "); for (i=1;i<=n;i++) known[a[i]]=1 }
		NR==FNR { known[$0]=1; next }
		($1=="option" || $1=="list") && !($2 in known) { print $2 }' \
		"$tmp/inventory.names" "$p" | sort -u)
	if [ -z "$unknown" ]; then
		ok "$src: no key outside the 66 upstream options + package-local ($PACKAGE_LOCAL_KEYS)"
	else
		fail "$src: unknown key(s) -- FATAL to the daemon: $(echo "$unknown" | tr "\n" " ")"
	fi
done

# ---------------------------------------------------------------- check 6
echo
echo "== 6. types agree with the inventory"
if diff -u "$tmp/inventory.types" "$tmp/tsv.types" > "$tmp/d4"; then
	ok "metadata type column == inventory type column for all 66 options"
else
	fail "type mismatch(es):"; sed 's/^/       /' "$tmp/d4"
fi

# ---------------------------------------------------------------- check 7
echo
echo "== 7. defaults are written in a form upstream accepts"
awk -F'\t' -v nonempty="$NONEMPTY_STRINGS" '
	BEGIN {
		n = split(nonempty, a, " ")
		for (i = 1; i <= n; i++) mustfill[a[i]] = 1
		bad = 0
	}
	$0 ~ /^#/ || NF == 0 { next }
	{
		name = $2; type = $3; def = $4
		if (type == "integer") {
			if (def !~ /^[0-9]+$/)
				{ printf "%s: integer default %s must be bare digits (a decimal point is a fatal type error upstream)\n", name, def; bad++ }
		} else if (type == "bool") {
			if (def !~ /^[01]$/)
				{ printf "%s: bool default %s must be 0 or 1\n", name, def; bad++ }
		} else if (type == "float") {
			if (def !~ /^[0-9]+\.[0-9]+$/)
				{ printf "%s: float default %s must carry a decimal point with digits either side\n", name, def; bad++ }
		} else if (type == "string") {
			if (def ~ /[\t]/) { printf "%s: string default contains a tab\n", name; bad++ }
			if ((name in mustfill) && def == "")
				{ printf "%s: string default may not be empty (upstream rejects an empty value for this option)\n", name; bad++ }
		} else if (type == "list") {
			if (def == "") { printf "%s: list default is empty\n", name; bad++ }
		} else {
			printf "%s: unknown type %s\n", name, type; bad++
			}
		if (def ~ /^-/) { printf "%s: negative default %s -- upstream rejects every negative value\n", name, def; bad++ }
	}
	END { exit (bad > 0) }
' "$TSV" > "$tmp/typecheck" 2>&1 && typeok=1 || typeok=0
if [ "$typeok" -eq 1 ]; then
	ok "all 66 metadata defaults are lexically valid for their type"
else
	fail "lexically invalid default(s):"; sed 's/^/       /' "$tmp/typecheck"
fi

# ---------------------------------------------------------------- check 8
echo
echo "== 8. shipped config values match the metadata defaults"
# scalar options
awk -F'\t' '
	NR==FNR { if ($0 !~ /^#/ && NF>0 && $3 != "list") def[$1]=$4; next }
	$1=="option" && ($2 in def) { print $2 "\t" $3 }
' "$TSV" "$parsed_config" | sort > "$tmp/config.values"
awk -F'\t' '$0 !~ /^#/ && NF>0 && $3 != "list" {print $1 "\t" $4}' "$TSV" | sort > "$tmp/tsv.values"
if diff -u "$tmp/tsv.values" "$tmp/config.values" > "$tmp/d5"; then
	ok "every scalar option in the shipped config carries its documented default"
else
	fail "shipped config vs metadata default mismatch:"; sed 's/^/       /' "$tmp/d5"
fi
# list options
awk -F'\t' '$1=="list" {printf "%s ", $3} END {print ""}' "$parsed_config" \
	| sed 's/ *$//' > "$tmp/config.list"
awk -F'\t' '$0 !~ /^#/ && NF>0 && $3=="list" {print $4}' "$TSV" > "$tmp/tsv.list"
if diff -u "$tmp/tsv.list" "$tmp/config.list" > "$tmp/d6"; then
	ok "reflector list in the shipped config == documented list default"
else
	fail "reflector list mismatch:"; sed 's/^/       /' "$tmp/d6"
fi

# ---------------------------------------------------------------- check 9
echo
echo "== 9. multi-instance"
nsec=$(awk -F'\t' '$1=="section"{c++} END{print c+0}' "$parsed_fixture")
if [ "$nsec" -ge 2 ]; then
	ok "fixture defines $nsec coexisting named instances"
else
	fail "fixture defines $nsec section(s), expected >= 2"
fi
# A sparse second instance must still be legal: every key it does set must be
# known (checked above) and it must not need any global/shared section.
if awk -F'\t' '$1=="section" && $2!="cake-autorate" {found=1} END{exit !found}' "$parsed_fixture"; then
	fail "fixture contains a non-instance (shared/global) section"
else
	ok "fixture has no shared/global section -- no cross-instance collisions"
fi

# --------------------------------------------------------------- check 10
if [ -n "$UPSTREAM_DEFAULTS" ]; then
	echo
	echo "== 10. cross-check against upstream defaults.sh ($UPSTREAM_DEFAULTS)"
	if [ ! -f "$UPSTREAM_DEFAULTS" ]; then
		fail "no such file: $UPSTREAM_DEFAULTS"
	else
		grep -E '^[A-Za-z_]+=' "$UPSTREAM_DEFAULTS" | sed 's/=.*//' > "$tmp/upstream.names"
		if diff -u "$tmp/upstream.names" "$tmp/inventory.names" > "$tmp/d7"; then
			ok "defaults.sh option list == inventory option list (same names, same order)"
		else
			fail "defaults.sh vs inventory differ:"; sed 's/^/       /' "$tmp/d7"
		fi
		# scalar upstream defaults, verbatim
		sed -e 's/[\t ]*#.*//' "$UPSTREAM_DEFAULTS" \
			| grep -E '^[A-Za-z_]+=' \
			| grep -v '^reflectors=' \
			| sed -e 's/=/\t/' -e 's/[\t ]*$//' \
			| awk -F'\t' '{ v=$2; gsub(/^"|"$/, "", v); print $1 "\t" v }' \
			| sort > "$tmp/upstream.values"
		awk -F'\t' '$0 !~ /^#/ && NF>0 && $3 != "list" {print $2 "\t" $5}' "$TSV" | sort > "$tmp/tsv.upstream.values"
		if diff -u "$tmp/upstream.values" "$tmp/tsv.upstream.values" > "$tmp/d8"; then
			ok "metadata upstream_default column == defaults.sh values, verbatim"
		else
			fail "metadata vs defaults.sh value mismatch:"; sed 's/^/       /' "$tmp/d8"
		fi
		# reflectors array
		sed -n '/^reflectors=(/,/^)/p' "$UPSTREAM_DEFAULTS" \
			| sed -e 's/#.*//' -e 's/^reflectors=(//' -e 's/^)//' \
			| tr -s ' \t\n' ' ' \
			| tr -d '"' \
			| sed -e 's/^ *//' -e 's/ *$//' > "$tmp/upstream.reflectors"
		echo >> "$tmp/upstream.reflectors"
		awk -F'\t' '$0 !~ /^#/ && NF>0 && $3=="list" {print $5}' "$TSV" > "$tmp/tsv.reflectors"
		if diff -u "$tmp/upstream.reflectors" "$tmp/tsv.reflectors" > "$tmp/d9"; then
			ok "metadata reflectors upstream_default == defaults.sh array, in order"
		else
			fail "reflector array mismatch:"; sed 's/^/       /' "$tmp/d9"
		fi
	fi
fi

echo
if [ "$fails" -eq 0 ]; then
	echo "PASS: $checks/$checks checks passed"
	echo "NOTE: 'uci import' / 'uci show' were not run -- libuci is not available"
	echo "      on a build host. The VM harness confirms those on-device."
	exit 0
fi
echo "FAIL: $fails of $checks checks failed"
exit 1
