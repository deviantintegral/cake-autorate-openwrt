#!/bin/sh
#
# Guards every place the tree restates a pinned version.
#
# THE BUG THIS EXISTS FOR
#   `net/cake-autorate/Makefile` pins the upstream cake-autorate tag, and
#   Renovate bumps it automatically. But the LuCI overview shipped its own copy
#   of that version as a string literal, and Renovate's custom manager was scoped
#   to the Makefile alone. Nothing connected the two. The next automatic bump
#   would have left the configuration page telling every user a version the feed
#   does not build -- silently, because a wrong-but-plausible version number
#   looks exactly like a right one. No test failed, because no test knew the
#   restatement existed.
#
#   The fix was to widen the custom manager. That only moves the problem one
#   level up: the safety now rests on a set of regexes in renovate.json
#   continuing to match, which is itself unverified. Reword the sentence around a
#   literal, or rename the JS constant, and a pattern breaks with no symptom at
#   all -- Renovate reports nothing when a matchString matches nothing, it just
#   stops updating that file. So this suite drives renovate.json as data and
#   checks the pins the way the tree actually uses them.
#
#   It runs over BOTH custom managers. `openwrt/openwrt` restates its pin in
#   ~30 places across ten files and carries the same invariants in prose, none
#   of which were enforced either; it passes today, and this keeps it passing.
#
# WHAT IT CHECKS, PER MANAGER
#   1. COVERAGE. Every managerFilePatterns entry matches a tracked file, and
#                every covered file yields at least one match. A file listed but
#                no longer matched is a restatement that has quietly stopped
#                being maintained -- the exact shape of the original bug.
#   2. LIVE PATTERNS. Every matchStrings pattern matches somewhere. A dead
#                pattern is invisible in Renovate's output.
#   3. AGREEMENT. Every literal the manager matches says the same version. One
#                hand-edited copy, or one file Renovate could not rewrite, fails
#                here.
#   4. OVERLAP.  No two patterns match the same span. renovate.json states this
#                invariant in prose for both managers -- "no two may match the
#                same literal, or the second update would look for a
#                replaceString the first already rewrote" -- and nothing checked
#                it.
#   5. STRAYS.   No UNMANAGED copy of the version hides in a covered file. This
#                is the general form of the original bug: add a second literal
#                to overview.js and it fails here rather than shipping.
#
#                Frozen by shape, not by a list of line numbers: a version
#                followed by `-r<digits>` is an apk name (cake-autorate-3.2.2-r1),
#                used in the Makefile and AGENTS.md to illustrate how apk orders
#                a release against a version. Those examples describe a past
#                incident and must NOT track the pin. A hand-maintained list of
#                exempt lines would rot exactly the way the version literals did.
#
# AND TWO ANCHORS THE MANAGERS CANNOT SUPPLY THEMSELVES
#   6. BUILD TRUTH. The cake-autorate manager's version equals `PKG_VERSION` in
#                net/cake-autorate/Makefile -- the field that actually selects
#                the tarball. Agreement among restatements is not enough if they
#                agree on the wrong number.
#   7. INVENTORY. docs/upstream-option-inventory.md records the tag it was cut
#                against, and is deliberately NOT in the manager: it carries a
#                tarball SHA-256, a tag commit and a 66-row option table that are
#                claims about a release someone inspected, so bumping the number
#                under them would turn a stale document into a confidently wrong
#                one. Its tag is asserted equal to PKG_VERSION instead, which
#                holds a bump PR red until a human re-runs the extraction. Same
#                contract as the two patch gates next door.
#
# Node does the renovate.json work (JSON + regex, and it is the one tool the
# unit job installs on purpose). Like test-graph-definition.sh, this NOTEs and
# skips when node is absent unless UNIT_NO_SKIP forbids it.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

MAKEFILE="$REPO_ROOT/net/cake-autorate/Makefile"
RENOVATE="$REPO_ROOT/renovate.json"
INVENTORY="$REPO_ROOT/docs/upstream-option-inventory.md"

for f in "$MAKEFILE" "$RENOVATE" "$INVENTORY"; do
	[ -f "$f" ] || { printf 'FAIL missing file: %s\n' "$f"; exit 1; }
done

# The field that selects the tarball, read straight from the Makefile so the
# anchor cannot be a second hand-copied constant.
PKG_VERSION=$(sed -n 's/^PKG_VERSION:=\([0-9][0-9.]*\)[[:space:]]*$/\1/p' "$MAKEFILE" | head -n 1)
[ -n "$PKG_VERSION" ] || {
	printf 'FAIL could not read PKG_VERSION from %s\n' "$MAKEFILE"
	exit 1
}

# Read here rather than through the manager: the inventory is intentionally
# absent from it -- see note 7 above.
INVENTORY_TAG=$(sed -n 's/^| Pinned tag | `v\([0-9][0-9.]*\)` |.*/\1/p' "$INVENTORY" | head -n 1)

if ! command -v node >/dev/null 2>&1; then
	# UNIT_NO_SKIP is exported by tests/run-unit.sh --no-skip, which CI and the
	# release gate pass. A self-skip that still exits 0 would hand back a green
	# pass over checks that never ran.
	if [ "${UNIT_NO_SKIP:-0}" = "1" ]; then
		printf 'FAIL: node not found, and UNIT_NO_SKIP=1 forbids skipping.\n' >&2
		exit 1
	fi
	printf 'NOTE: node not found -- version pin checks skipped.\n'
	printf '      Install node (CI does) to run them; run-unit.sh --no-skip makes\n'
	printf '      this an error rather than a skip.\n'
	exit 0
fi

REPO_ROOT="$REPO_ROOT" PKG_VERSION="$PKG_VERSION" INVENTORY_TAG="$INVENTORY_TAG" node -e '
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = process.env.REPO_ROOT;
const pkgVersion = process.env.PKG_VERSION;
const inventoryTag = process.env.INVENTORY_TAG;

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log("ok   " + m); };
const bad = (m) => { fail++; console.log("FAIL " + m); };

const cfg = JSON.parse(fs.readFileSync(path.join(root, "renovate.json"), "utf8"));
const managers = (cfg.customManagers || []).filter((m) => m.customType === "regex");

if (managers.length === 0) {
	console.log("FAIL renovate.json declares no regex customManagers");
	process.exit(1);
}

/* Every tracked path, so a pattern aimed at a file that has MOVED reports zero
 * covered files rather than passing vacuously. */
const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
	.split("\n").filter(Boolean);

const lineOf = (text, at) => text.slice(0, at).split("\n").length;

/* The pin each manager agrees on, so the anchors below can be checked against
 * the same value the manager would rewrite. */
const pinByDep = new Map();

for (const mgr of managers) {
	const dep = mgr.depNameTemplate || "(unnamed manager)";

	/* Renovate writes managerFilePatterns as /regex/ -- unwrap to a plain RegExp
	 * so the expression that selects files there selects them here. */
	const fileRes = (mgr.managerFilePatterns || []).map((p) => {
		const m = /^\/(.*)\/$/.exec(p);
		if (!m) { bad(dep + ": managerFilePatterns entry is not /regex/ form: " + p); return null; }
		return { src: p, re: new RegExp(m[1]) };
	}).filter(Boolean);

	for (const r of fileRes) {
		if (!tracked.some((f) => r.re.test(f)))
			bad(dep + ": managerFilePatterns " + r.src + " matches no tracked file");
	}

	const covered = tracked.filter((f) => fileRes.some((r) => r.re.test(f)));
	if (covered.length === 0) {
		bad(dep + ": covers no files at all");
		continue;
	}
	ok(dep + ": covers " + covered.length + " file(s)");

	const patterns = (mgr.matchStrings || []).map((s) => ({ src: s, re: new RegExp(s, "g") }));
	if (patterns.length === 0) { bad(dep + ": has no matchStrings"); continue; }

	/* --- 1 coverage, 2 live patterns, 3 agreement, 4 overlap --------------- */

	const spansByFile = new Map();
	const hits = new Map(patterns.map((p) => [p.src, 0]));
	const values = new Map();          // version -> ["file:line", ...]
	let unnamed = 0;

	for (const rel of covered) {
		const text = fs.readFileSync(path.join(root, rel), "utf8");
		const spans = [];

		for (const p of patterns) {
			p.re.lastIndex = 0;
			let m;
			while ((m = p.re.exec(text)) !== null) {
				if (m[0].length === 0) { p.re.lastIndex++; continue; }
				hits.set(p.src, hits.get(p.src) + 1);
				spans.push({ start: m.index, end: m.index + m[0].length, pattern: p.src });

				const got = m.groups && m.groups.currentValue;
				if (got === undefined) {
					unnamed++;
					bad(dep + ": pattern has no currentValue group: " + p.src);
				} else {
					if (!values.has(got)) values.set(got, []);
					values.get(got).push(rel + ":" + lineOf(text, m.index));
				}
			}
		}

		spansByFile.set(rel, spans);

		if (spans.length === 0)
			bad(dep + ": " + rel + " is covered but matched by NO pattern -- the " +
				"restatement here is unmaintained, or a pattern broke when the text " +
				"around it was reworded");

		/* Overlap: renovate.json states this invariant in prose for both managers. */
		const sorted = spans.slice().sort((a, b) => a.start - b.start);
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i].start < sorted[i - 1].end)
				bad(dep + ": " + rel + ": two patterns match one literal -- " +
					sorted[i - 1].pattern + " and " + sorted[i].pattern +
					". The second update would look for a replaceString the first " +
					"already rewrote.");
		}
	}

	const dead = [...hits].filter(([, n]) => n === 0).map(([s]) => s);
	for (const s of dead)
		bad(dep + ": matchStrings pattern matches nothing anywhere: " + s +
			" (Renovate reports no error for this -- it just stops updating)");
	if (dead.length === 0 && unnamed === 0)
		ok(dep + ": all " + patterns.length + " pattern(s) live and capturing");

	if (values.size === 0) {
		bad(dep + ": matched no version at all");
		continue;
	}
	if (values.size > 1) {
		const summary = [...values].sort((a, b) => b[1].length - a[1].length)
			.map(([v, where]) => v + " at " + where.join(", ")).join("; ");
		bad(dep + ": its restatements disagree -- " + summary +
			". One of them was hand-edited, or Renovate could not rewrite it.");
		continue;
	}

	const pin = [...values.keys()][0];
	pinByDep.set(dep, pin);
	ok(dep + ": " + [...values.values()][0].length + " restatement(s) agree on " + pin);

	/* --- 5 strays --------------------------------------------------------- */

	const pinRe = new RegExp("(?<![0-9.])" + pin.replace(/\./g, "\\.") + "(?![0-9])", "g");

	for (const rel of covered) {
		const text = fs.readFileSync(path.join(root, rel), "utf8");
		const spans = spansByFile.get(rel) || [];
		const strays = [];

		let m;
		pinRe.lastIndex = 0;
		while ((m = pinRe.exec(text)) !== null) {
			const at = m.index;
			if (spans.some((s) => at >= s.start && at < s.end)) continue;
			/* An apk name -- cake-autorate-3.2.2-r1 -- illustrates how apk orders a
			 * release against a version. Those examples are about a past incident
			 * and must not track the pin. Recognised by shape, so no list of exempt
			 * lines has to be maintained. */
			if (/^-r\d/.test(text.slice(at + pin.length))) continue;
			strays.push(lineOf(text, at));
		}

		if (strays.length)
			bad(dep + ": " + rel + " has an unmanaged copy of the version at line(s) " +
				strays.join(", ") + " -- Renovate will not rewrite it, so the next " +
				"bump ships it stale. Either add a matchString for it, or reword it " +
				"to not name a version.");
	}
}

/* --- 6 build truth -------------------------------------------------------- */

const CA_DEP = "lynxthecat/cake-autorate";
const caPin = pinByDep.get(CA_DEP);
if (caPin === undefined && !managers.some((m) => m.depNameTemplate === CA_DEP))
	bad("renovate.json has no " + CA_DEP + " custom manager -- nothing keeps the " +
		"restatements in step with the PKG_VERSION the feed builds");
else if (caPin === undefined)
	console.log("     (skipping the PKG_VERSION anchor: " + CA_DEP +
		" has no agreed version -- see its failure above)");
else if (caPin !== pkgVersion)
	bad("the cake-autorate restatements say " + caPin + " but net/cake-autorate/Makefile " +
		"builds PKG_VERSION " + pkgVersion + ". The tarball the feed downloads is the " +
		"Makefile one; everything else is telling users something different.");
else
	ok("cake-autorate restatements match the PKG_VERSION the feed builds (" + pkgVersion + ")");

/* --- 7 inventory ---------------------------------------------------------- */

if (!inventoryTag)
	bad("docs/upstream-option-inventory.md: could not read its `Pinned tag` row");
else if (inventoryTag !== pkgVersion)
	bad("docs/upstream-option-inventory.md was cut against v" + inventoryTag +
		" but PKG_VERSION is now " + pkgVersion + ". It is NOT auto-rewritten on purpose: " +
		"its tag commit, tarball SHA-256 and 66-option table are claims about a " +
		"release someone inspected. Re-run the extraction in its section 1, refresh " +
		"those and the option table, then update the `Pinned tag` row.");
else
	ok("docs/upstream-option-inventory.md was cut against the pinned tag v" + pkgVersion);

console.log("");
console.log(fail === 0
	? "PASS: " + pass + " checks"
	: "FAIL: " + fail + " failed, " + pass + " passed");
process.exit(fail === 0 ? 0 : 1);
'
