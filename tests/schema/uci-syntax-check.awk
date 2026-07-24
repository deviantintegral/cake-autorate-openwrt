# uci-syntax-check.awk -- validate OpenWrt UCI config-file grammar.
#
# Deliberately STRICTER than libuci: anything this accepts, uci accepts. The
# reverse is not guaranteed (e.g. we reject trailing comments on a value line
# and unquoted values containing '#', both of which we simply never emit).
#
# Cross-checked against libuci's own parser (openwrt/uci master):
#   file.c uci_parse_line()   - a line whose first token starts with '#' is
#                               ignored, after leading whitespace is skipped
#                               => whole-line comments, indented or not, are legal
#   file.c uci_parse_option() - "option/list command found before the first
#                               section" is a parse error => option/list must
#                               follow a config line
#   file.c uci_parse_config() + assert_eol() - exactly one type and at most one
#                               name, nothing after them
#   util.c uci_validate_str() - NAMES (section name, option name) allow only
#                               alnum and '_'; TYPES additionally allow any
#                               printable char, so the 'cake-autorate' section
#                               type (with its hyphen) is valid
#
# Grammar enforced:
#   <blank>
#   # comment                        (whole-line only)
#   package <value>
#   config <type> [<name>]
#   option <name> <value>            (must follow a config line)
#   list   <name> <value>            (must follow a config line)
#
# Values are single-quoted, double-quoted, or a bare token free of whitespace,
# quotes and '#'.
#
# Exit status: 0 clean, 1 if any error was reported.
# Usage: awk -f uci-syntax-check.awk <file>

function err(msg) {
	printf "%s:%d: error: %s\n\t%s\n", FILENAME, FNR, msg, $0 > "/dev/stderr"
	errors++
}

# Is s exactly one well-formed value token and nothing else?
function value_ok(s,   q, inner) {
	if (s == "")
		return 0
	q = substr(s, 1, 1)
	if (q == "'" || q == "\"") {
		if (length(s) < 2)
			return 0
		if (substr(s, length(s), 1) != q)
			return 0
		inner = substr(s, 2, length(s) - 2)
		# an unescaped closing quote inside the body ends the token early
		if (index(inner, q) != 0)
			return 0
		return 1
	}
	return (s ~ /^[^ \t'"#]+$/)
}

function unquote(s,   q) {
	q = substr(s, 1, 1)
	if (q == "'" || q == "\"")
		return substr(s, 2, length(s) - 2)
	return s
}

BEGIN {
	in_section = 0
	errors = 0
	sections = 0
}

{
	line = $0
	sub(/\r$/, "", line)
	sub(/^[ \t]+/, "", line)
	sub(/[ \t]+$/, "", line)

	if (line == "")
		next
	if (substr(line, 1, 1) == "#")
		next

	if (match(line, /^package[ \t]+/)) {
		rest = substr(line, RLENGTH + 1)
		if (!value_ok(rest))
			err("malformed package name")
		next
	}

	if (match(line, /^config[ \t]+/)) {
		rest = substr(line, RLENGTH + 1)
		if (!match(rest, /^[A-Za-z0-9_-]+/)) {
			err("config: missing or invalid section type")
			next
		}
		stype = substr(rest, 1, RLENGTH)
		rest = substr(rest, RLENGTH + 1)
		sub(/^[ \t]+/, "", rest)
		sname = ""
		if (rest != "") {
			if (!value_ok(rest)) {
				err("config: malformed section name")
				next
			}
			sname = unquote(rest)
			if (sname !~ /^[A-Za-z0-9_]+$/) {
				err("config: section name must match [A-Za-z0-9_]+")
				next
			}
		}
		in_section = 1
		sections++
		printf "section\t%s\t%s\n", stype, sname
		next
	}

	if (match(line, /^(option|list)[ \t]+/)) {
		kw = (line ~ /^option/) ? "option" : "list"
		rest = substr(line, RLENGTH + 1)
		if (!in_section) {
			err(kw " outside of any config section")
			next
		}
		if (!match(rest, /^[A-Za-z0-9_]+/)) {
			err(kw ": missing or invalid option name")
			next
		}
		oname = substr(rest, 1, RLENGTH)
		rest = substr(rest, RLENGTH + 1)
		sub(/^[ \t]+/, "", rest)
		if (rest == "") {
			err(kw " " oname ": missing value")
			next
		}
		if (!value_ok(rest)) {
			err(kw " " oname ": malformed value (unbalanced quotes or stray whitespace/#)")
			next
		}
		printf "%s\t%s\t%s\n", kw, oname, unquote(rest)
		next
	}

	err("unrecognised line (expected blank, comment, package, config, option or list)")
}

END {
	if (sections == 0) {
		printf "%s: error: no config section found\n", FILENAME > "/dev/stderr"
		errors++
	}
	if (errors > 0) {
		printf "%s: %d UCI syntax error(s)\n", FILENAME, errors > "/dev/stderr"
		exit 1
	}
}
