#!/bin/sh
#
# Tests the luci-app-statistics graph definition
# (luci/luci-app-cake-autorate/htdocs/luci-static/resources/statistics/
#  rrdtool/definitions/cake_autorate.js)
# against the reader that actually produces the RRDs
# (net/cake-autorate/files/cake-autorate-collectd.sh).
#
# WHY THIS EXISTS
#   The two files are a contract with no compiler between them: the reader picks
#   the `<type>-<type_instance>` names, and the definition has to name the same
#   ones back. Nothing on the device complains when they drift -- luci-app-
#   statistics just draws a panel with an unnamed series and a legend reading
#   "dt=bitrate/di=(nil)/ds=value", which looks like missing DATA rather than a
#   missing definition. That is exactly how the per_instance bug below hid.
#
# WHAT IT CHECKS
#   1. No graph sets `per_instance: true`. rrdtool.js only consults our
#      `data.instances` list on the FALSE branch:
#
#          if (!opts.per_instance) {
#              if (L.isObject(opts.data.instances) && Array.isArray(...[dt]))
#                  data_instances = opts.data.instances[dt];
#          }
#          if (!Array.isArray(data_instances) || data_instances.length == 0)
#              data_instances = [ '' ];
#
#      With it true the lists are skipped, every panel collapses to the unnamed
#      instance '', and the outer loop fans each definition out across the data
#      instances of its first source's type -- 3 graphs became 12. One panel per
#      WAN needs nothing from us: rrdargs() is already called once per collectd
#      plugin instance, and "%pi" expands to that instance id.
#   2. data.instances names exactly the metrics the reader emits -- no metric
#      graphed that is never produced, none produced that is never graphed.
#   3. Every series has a data.options entry under the "<dtype>_<instance>" key
#      rrdtool.js looks it up by, each with a human title, so no legend can fall
#      back to the "di=(nil)" placeholder.
#
# Node is used to load the definition (it is a LuCI class file, so it gets a
# stubbed `baseclass` and `_`). Like the libuci checks in test-uci-schema.sh,
# this NOTEs and skips rather than failing when the tool is absent.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

DEFINITION="$REPO_ROOT/luci/luci-app-cake-autorate/htdocs/luci-static/resources/statistics/rrdtool/definitions/cake_autorate.js"
READER="$REPO_ROOT/net/cake-autorate/files/cake-autorate-collectd.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }

for f in "$DEFINITION" "$READER"; do
	[ -f "$f" ] || { printf 'FAIL missing file: %s\n' "$f"; exit 1; }
done

if ! command -v node >/dev/null 2>&1; then
	printf 'NOTE: node not found -- graph definition checks skipped.\n'
	printf '      CI runs node for the Playwright job; install it to run these.\n'
	exit 0
fi

# The metric list the reader emits, straight from its put(...) calls, so the
# expectation cannot be hand-copied out of date: put("bitrate-dl_achieved", $4)
# -> bitrate-dl_achieved.
EMITTED=$(sed -n 's/.*put(\"\([a-z0-9_]*-[a-z0-9_]*\)\".*/\1/p' "$READER" | sort -u)

[ -n "$EMITTED" ] || { printf 'FAIL could not scrape any put() metric from %s\n' "$READER"; exit 1; }

ACTUAL=$(EMITTED="$EMITTED" DEFINITION="$DEFINITION" node -e '
const fs = require("fs");

const src = fs.readFileSync(process.env.DEFINITION, "utf8");
const stubBase = { extend: (o) => o };
const mod = new Function("baseclass", "_", src)(stubBase, (s) => s);

const graphs = [].concat(mod.rrdargs({}, "host", "cake_autorate", "primary", null));
const problems = [];
const graphed = new Set();

graphs.forEach((g, i) => {
	const where = g.title || ("graph #" + i);

	if (g.per_instance !== false)
		problems.push(where + ": per_instance is " + JSON.stringify(g.per_instance) +
			", must be false (true makes rrdtool.js ignore data.instances)");

	const instances = (g.data && g.data.instances) || {};
	const options = (g.data && g.data.options) || {};
	const usedKeys = new Set();

	Object.keys(instances).forEach((dtype) => {
		const list = instances[dtype];
		if (!Array.isArray(list) || list.length === 0) {
			problems.push(where + ": data.instances." + dtype + " is not a non-empty array");
			return;
		}
		list.forEach((di) => {
			graphed.add(dtype + "-" + di);
			// rrdtool.js resolves the per-series display options under this key.
			const key = dtype + "_" + di;
			usedKeys.add(key);
			const o = options[key];
			if (!o)
				problems.push(where + ": no data.options[\"" + key + "\"] -- legend would read di=(nil)");
			else if (!o.title)
				problems.push(where + ": data.options[\"" + key + "\"] has no title");
		});
	});

	Object.keys(options).forEach((key) => {
		if (!usedKeys.has(key))
			problems.push(where + ": data.options[\"" + key + "\"] matches no entry in data.instances");
	});
});

const emitted = new Set(process.env.EMITTED.split("\n").filter(Boolean));
[...emitted].filter((m) => !graphed.has(m)).forEach((m) =>
	problems.push("reader emits " + m + " but no graph plots it"));
[...graphed].filter((m) => !emitted.has(m)).forEach((m) =>
	problems.push("a graph plots " + m + " but the reader never emits it"));

console.log(JSON.stringify({ graphCount: graphs.length, problems }));
' 2>&1) || { printf 'FAIL node failed to load the definition:\n%s\n' "$ACTUAL"; exit 1; }

GRAPH_COUNT=$(printf '%s' "$ACTUAL" | sed -n 's/.*"graphCount":\([0-9]*\).*/\1/p')
PROBLEMS=$(printf '%s' "$ACTUAL" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
	JSON.parse(s).problems.forEach((p) => console.log(p));
});')

if [ "$GRAPH_COUNT" = "3" ]; then
	ok "rrdargs() returns the 3 graphs (rates, OWD delta, load state)"
else
	bad "rrdargs() returned $GRAPH_COUNT graphs, expected 3"
fi

if [ -z "$PROBLEMS" ]; then
	ok "every graph sets per_instance: false"
	ok "data.instances matches the reader's put() metrics exactly"
	ok "every series has a titled data.options entry"
else
	printf '%s\n' "$PROBLEMS" | while IFS= read -r p; do printf 'FAIL %s\n' "$p"; done
	FAIL=$((FAIL + $(printf '%s\n' "$PROBLEMS" | wc -l)))
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
	printf 'PASS: %d/%d checks passed\n' "$PASS" "$PASS"
	exit 0
fi
printf 'FAIL: %d failed, %d passed\n' "$FAIL" "$PASS"
exit 1
