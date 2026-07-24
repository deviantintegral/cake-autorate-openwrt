#!/bin/sh
# shellcheck disable=SC3043
# cake-autorate-bridge.sh -- UCI -> upstream per-instance shell config bridge.
#
# Owned by plan 01 / task 4. Installed to
# /usr/libexec/cake-autorate/cake-autorate-bridge.sh (task 2 Makefile).
#
# WHAT IT DOES
#   Reads the UCI package "cake-autorate" and, for every ENABLED instance
#   section, writes a deterministic upstream daemon config to
#       <config-dir>/config.<instance>.sh        (default /etc/cake-autorate)
#   The daemon sources defaults.sh then this file, so only the keys an instance
#   actually sets are emitted, plus the package-managed keys (see below).
#
#   Section name == instance id (constrained to [A-Za-z0-9_]+). The per-instance
#   log path the daemon derives is /var/log/cake-autorate.<instance>.log; that
#   determinism is guaranteed here by forcing log_file_path_override="".
#
# GUARANTEES
#   * Deterministic + idempotent: emission order is the fixed schema order, no
#     timestamps, so the same UCI yields byte-identical output.
#   * Strict upstream typing (see docs/upstream-option-inventory.md 2.3):
#       - float options carry a decimal point (1 -> 1.0, .5 -> 0.5)
#       - integer options carry none (6.0 -> 6, 6.5 is fatal)
#       - bool truthy/falsy spellings normalise to 0/1
#       - non-empty-default strings (dl_if/ul_if/pinger_binary) never blanked
#       - reflectors emitted as a bash array literal, validated IPv4/IPv6
#       - negatives rejected everywhere
#       - only the 66 upstream keys are ever emitted (an unknown key is fatal)
#   * Package-managed keys (docs/uci-schema.md section 4):
#       - forced  : written AFTER user options with a fixed value so a user
#                   cannot disable the log stream the LuCI status view and the
#                   collectd tail source depend on.
#       - bounded : user-settable but clamped to a sane non-zero range.
#   * Bidirectional coverage invariant enforced in code: every UCI user option
#     maps to exactly one emitted key, and every emitted key (minus the forced
#     ones) maps back to a UCI option. A silent drop or a stray key is fatal.
#
# INVOCATION
#   cake-autorate-bridge.sh [--config-dir DIR] [--instance NAME]
#                           [--uci-file FILE] [--stdout] [--no-prune]
#                           [--check-schema]
#
#   (no args)         Sync all enabled instances from live UCI into the config
#                     dir and PRUNE any stale config.*.sh whose instance is no
#                     longer an enabled section. This is the whole-world sync
#                     the init script (task 5) calls on start/reload.
#   --instance NAME   Only process section NAME (implies --no-prune).
#   --config-dir DIR  Output directory (default $CAKE_AUTORATE_CONFIG_PREFIX or
#                     /etc/cake-autorate).
#   --uci-file FILE   Read UCI from FILE (parsed by the task-3 grammar checker)
#                     instead of libuci -- for off-device tests/CI. Requires the
#                     parser at $CAKE_AUTORATE_UCI_AWK or beside this script.
#   --stdout          Write the (single) selected instance to stdout instead of
#                     a file, ignoring its enabled flag. Requires --instance.
#   --no-prune        Do not delete stale config.*.sh.
#   --check-schema    Print the embedded schema (name<TAB>type<TAB>managed) and
#                     exit; used by the test suite to prove no drift vs the TSV.
#
# Exit status: 0 on success; 1 on any fatal (bad type, unknown key, coverage
# mismatch, ...). A fatal on one instance aborts the whole run so a half-written
# config never reaches the daemon.

set -u

PROG=cake-autorate-bridge

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
warn() { printf '%s: %s\n' "$PROG" "$*" >&2; }

TAB=$(printf '\t')
SENTINEL='__CAKE_AUTORATE_UNSET__'

# --------------------------------------------------------------------------
# Embedded option schema.
#
# DERIVED FROM docs/uci-option-schema.tsv (columns 1=uci_option, 3=type,
# 6=managed). Kept in lockstep by tests/bridge/test-bridge.sh --check-schema,
# which fails the build if this table and the TSV ever diverge. Do not hand-edit
# without regenerating from the TSV:
#   awk -F'\t' '$0!~/^#/ && NF>0 {print $1"\t"$3"\t"$6}' docs/uci-option-schema.tsv
# --------------------------------------------------------------------------
_schema() {
	cat <<-'EOF'
	output_processing_stats	bool	user
	output_load_stats	bool	user
	output_reflector_stats	bool	user
	output_summary_stats	bool	forced
	output_cake_changes	bool	user
	debug	bool	user
	log_DEBUG_messages_to_syslog	bool	forced
	log_to_file	bool	forced
	log_file_max_time_mins	integer	bounded
	log_file_max_size_KB	integer	bounded
	log_file_path_override	string	forced
	dl_if	string	user
	ul_if	string	user
	pinger_binary	string	user
	reflectors	list	user
	randomize_reflectors	bool	user
	no_pingers	integer	user
	reflector_ping_interval_s	float	user
	dl_owd_delta_thr_ms	float	user
	ul_owd_delta_thr_ms	float	user
	dl_avg_owd_delta_thr_ms	float	user
	ul_avg_owd_delta_thr_ms	float	user
	adjust_dl_shaper_rate	bool	user
	adjust_ul_shaper_rate	bool	user
	min_dl_shaper_rate_kbps	integer	user
	base_dl_shaper_rate_kbps	integer	user
	max_dl_shaper_rate_kbps	integer	user
	min_ul_shaper_rate_kbps	integer	user
	base_ul_shaper_rate_kbps	integer	user
	max_ul_shaper_rate_kbps	integer	user
	enable_sleep_function	bool	user
	connection_active_thr_kbps	integer	user
	sustained_idle_sleep_thr_s	float	user
	min_shaper_rates_enforcement	bool	user
	startup_wait_s	float	user
	log_file_buffer_size_B	integer	bounded
	log_file_buffer_timeout_ms	integer	bounded
	log_file_export_compress	bool	user
	ping_extra_args	string	user
	ping_prefix_string	string	user
	monitor_achieved_rates_interval_ms	integer	user
	bufferbloat_detection_window	integer	user
	bufferbloat_detection_thr	integer	user
	alpha_baseline_increase	float	user
	alpha_baseline_decrease	float	user
	alpha_delta_ewma	float	user
	shaper_rate_min_adjust_down_bufferbloat	float	user
	shaper_rate_max_adjust_down_bufferbloat	float	user
	shaper_rate_adjust_up_load_high	float	user
	shaper_rate_adjust_down_load_low	float	user
	shaper_rate_adjust_up_load_low	float	user
	high_load_thr	float	user
	bufferbloat_refractory_period_ms	integer	user
	decay_refractory_period_ms	integer	user
	reflector_health_check_interval_s	float	user
	reflector_response_deadline_s	float	user
	reflector_misbehaving_detection_window	integer	user
	reflector_misbehaving_detection_thr	integer	user
	reflector_replacement_interval_mins	integer	user
	reflector_comparison_interval_mins	integer	user
	reflector_sum_owd_baselines_delta_thr_ms	float	user
	reflector_owd_delta_ewma_delta_thr_ms	float	user
	stall_detection_thr	integer	user
	connection_stall_thr_kbps	integer	user
	global_ping_response_timeout_s	float	user
	if_up_check_interval_s	float	user
	EOF
}

# Forced keys and their pinned values, emitted (in this order) AFTER user
# options. log_file_path_override="" pins the log to the per-instance path
# /var/log/cake-autorate.<instance>.log (inventory 3.1).
FORCED_NAMES='output_summary_stats log_DEBUG_messages_to_syslog log_to_file log_file_path_override'
forced_value() {
	case "$1" in
		output_summary_stats)         printf '1' ;;
		log_DEBUG_messages_to_syslog) printf '0' ;;
		log_to_file)                  printf '1' ;;
		log_file_path_override)       printf '' ;;   # empty on purpose
		*) die "internal: no forced value for '$1'" ;;
	esac
}

# Bounded keys: sane non-zero [min,max] clamp range (docs/uci-schema.md 4).
bounded_range() {
	case "$1" in
		log_file_max_time_mins)     printf '1 1440' ;;
		log_file_max_size_KB)       printf '64 102400' ;;
		log_file_buffer_size_B)     printf '1 1048576' ;;
		log_file_buffer_timeout_ms) printf '1 60000' ;;
		*) die "internal: no bounded range for '$1'" ;;
	esac
}

schema_type() { _schema | awk -F'\t' -v n="$1" '$1==n {print $2; exit}'; }

# --------------------------------------------------------------------------
# Value coercion. Each prints the emitted lexical form to stdout, or prints a
# diagnostic to stderr and returns 1. Callers MUST test the return status
# ( out=$(coerce_int ...) || die ... ) because a bare `exit` inside $() would
# only leave the sub-shell.
# --------------------------------------------------------------------------
coerce_int() {
	local n="$1" v="$2" int frac
	case "$v" in -*) warn "$n: negative value '$v' rejected"; return 1 ;; esac
	case "$v" in
		*.*)
			int=${v%%.*}; frac=${v#*.}
			case "$int" in ''|*[!0-9]*) warn "$n: not an integer '$v'"; return 1 ;; esac
			case "$frac" in *[!0-9]*) warn "$n: not an integer '$v'"; return 1 ;; esac
			case "$frac" in *[!0]*) warn "$n: non-integral value '$v' (a decimal point is fatal upstream)"; return 1 ;; esac
			printf '%s' "$int" ;;
		''|*[!0-9]*) warn "$n: not an integer '$v'"; return 1 ;;
		*) printf '%s' "$v" ;;
	esac
}

coerce_float() {
	local n="$1" v="$2" int frac
	case "$v" in -*) warn "$n: negative value '$v' rejected"; return 1 ;; esac
	case "$v" in
		*.*)
			int=${v%%.*}; frac=${v#*.}
			case "$frac" in *.*) warn "$n: malformed float '$v'"; return 1 ;; esac
			case "$int" in *[!0-9]*) warn "$n: malformed float '$v'"; return 1 ;; esac
			case "$frac" in *[!0-9]*) warn "$n: malformed float '$v'"; return 1 ;; esac
			[ -n "$int" ] || int=0
			[ -n "$frac" ] || frac=0
			printf '%s.%s' "$int" "$frac" ;;
		''|*[!0-9]*) warn "$n: malformed float '$v'"; return 1 ;;
		*) printf '%s.0' "$v" ;;   # bare integer -> add the mandatory decimal point
	esac
}

coerce_bool() {
	local n="$1" v="$2" lc
	lc=$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')
	case "$lc" in
		1|true|yes|on|enabled)         printf '1' ;;
		0|false|no|off|disabled|'')    printf '0' ;;
		*) warn "$n: not a boolean '$v'"; return 1 ;;
	esac
}

coerce_string() {
	local n="$1" v="$2" esc
	case "$n" in
		dl_if|ul_if|pinger_binary)
			[ -n "$v" ] || { warn "$n: must not be empty (upstream rejects a blank value for this option)"; return 1; } ;;
	esac
	# Escape for a bash double-quoted string: backslash first, then " $ `.
	# shellcheck disable=SC2016  # single quotes are intentional -- these are literal sed replacements
	esc=$(printf '%s' "$v" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g' -e 's/`/\\`/g')
	printf '"%s"' "$esc"
}

# Rate-unit normalisation for the *_kbps integer options: accept an optional
# unit suffix (k/kbit/kbps, m/mbit/mbps, g/gbit/gbps, case-insensitive, optional
# "/s") and resolve to a plain kbps integer. Bare numbers are already kbps.
normalize_rate() {
	local n="$1" v="$2" num unit factor out
	num=${v%%[!0-9.]*}
	unit=${v#"$num"}
	unit=$(printf '%s' "$unit" | tr '[:upper:]' '[:lower:]')
	case "$unit" in */s) unit=${unit%/s} ;; esac
	case "$unit" in
		''|k|kbit|kbps) factor=1 ;;
		m|mbit|mbps)    factor=1000 ;;
		g|gbit|gbps)    factor=1000000 ;;
		*) warn "$n: unknown rate unit in '$v'"; return 1 ;;
	esac
	case "$num" in ''|*[!0-9.]*|*.*.*) warn "$n: bad rate value '$v'"; return 1 ;; esac
	out=$(awk -v x="$num" -v f="$factor" 'BEGIN{ v=x*f; if (v>=0 && v==int(v)) printf "%d", v; else exit 1 }') \
		|| { warn "$n: rate '$v' does not resolve to a whole kbps"; return 1; }
	printf '%s' "$out"
}

# Reflector validation (IPv4 or IPv6 literal).
valid_reflector() {
	awk -v a="$1" 'BEGIN{
		if (a ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
			split(a, o, ".")
			for (i = 1; i <= 4; i++) {
				if (o[i] == "" || length(o[i]) > 3 || o[i] + 0 > 255) exit 1
			}
			exit 0
		}
		if (a ~ /^[0-9A-Fa-f:.]+$/ && a ~ /:/ && index(a, ":::") == 0) exit 0
		exit 1
	}'
}

# Read newline-separated reflector entries on stdin, emit the bash array literal.
emit_reflectors() {
	local arr='' v esc n=0
	while IFS= read -r v; do
		[ -n "$v" ] || continue
		if valid_reflector "$v"; then
			esc=$(printf '%s' "$v" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
			arr="$arr \"$esc\""
			n=$((n + 1))
		else
			warn "reflectors: dropping invalid entry '$v'"
		fi
	done
	if [ "$n" -eq 0 ]; then
		warn "reflectors: no valid IPv4/IPv6 entries remain"
		return 1
	fi
	printf 'reflectors=(%s )' "$arr"
}

# --------------------------------------------------------------------------
# UCI stream producers. Both emit the canonical 3-column stream that the task-3
# grammar checker prints:
#     section<TAB>cake-autorate<TAB><name>
#     option<TAB><name><TAB><value>
#     list<TAB><name><TAB><value>
# --------------------------------------------------------------------------
stream_from_file() {
	local file="$1" parser="${CAKE_AUTORATE_UCI_AWK:-}" d c
	if [ -z "$parser" ]; then
		d=$(dirname "$0")
		for c in "$d/uci-syntax-check.awk" "$d/../../tests/schema/uci-syntax-check.awk"; do
			[ -f "$c" ] && { parser="$c"; break; }
		done
	fi
	if [ -z "$parser" ] || [ ! -f "$parser" ]; then
		die "UCI grammar checker not found; set CAKE_AUTORATE_UCI_AWK to tests/schema/uci-syntax-check.awk"
	fi
	awk -f "$parser" "$file" || die "UCI syntax error in $file"
}

stream_from_libuci() {
	# shellcheck disable=SC1091
	. /lib/functions.sh
	config_load cake-autorate
	config_foreach _libuci_emit_section cake-autorate
}

# Invoked indirectly by config_foreach (libuci mode only).
# shellcheck disable=SC2317
_libuci_emit_section() {
	local sid="$1" opt val r
	printf 'section\tcake-autorate\t%s\n' "$sid"
	# enabled first, then every known option, probed with a sentinel so an
	# unset option is distinguishable from one set to the empty string.
	for opt in enabled $(_schema | cut -f1); do
		config_get val "$sid" "$opt" "$SENTINEL"
		[ "$val" = "$SENTINEL" ] && continue
		if [ "$opt" = reflectors ]; then
			for r in $val; do
				printf 'list\treflectors\t%s\n' "$r"
			done
		else
			printf 'option\t%s\t%s\n' "$opt" "$val"
		fi
	done
}

# --------------------------------------------------------------------------
# Per-section processing.
# $1 = instance name, $2 = path to that section's record file (option/list lines
# from the stream). Writes the config file (or stdout) and enforces coverage.
# --------------------------------------------------------------------------
process_section() {
	local name="$1" rec="$2"
	local enabled_raw enabled t v line vals out present expected emitted line_count uniq_count kbps

	case "$name" in
		''|*[!A-Za-z0-9_]*) die "invalid instance name '$name' (must match [A-Za-z0-9_]+)" ;;
	esac

	# --instance filter
	if [ -n "$SELECT_INSTANCE" ] && [ "$name" != "$SELECT_INSTANCE" ]; then
		return 0
	fi

	# enabled gate (default off). --stdout inspects a specific instance
	# regardless, so it bypasses the gate.
	enabled_raw=$(grep -E "^option${TAB}enabled${TAB}" "$rec" | tail -n1)
	enabled_raw=${enabled_raw#option"${TAB}"enabled"${TAB}"}
	enabled=$(coerce_bool enabled "$enabled_raw") || die "$name: bad enabled value"
	if [ "$STDOUT" -eq 0 ] && [ "$enabled" != 1 ]; then
		return 0
	fi

	# Unknown-key check + collect the present user-option set. `enabled` is the
	# one package-local key and is never an upstream option.
	present=$(awk -F'\t' -v s="$SENTINEL" '
		($1=="option" || $1=="list") && $2!="enabled" { print $2 }
	' "$rec" | sort -u)
	for v in $present; do
		t=$(schema_type "$v")
		[ -n "$t" ] || die "$name: unknown UCI option '$v' (a key outside the 66 upstream options is fatal to the daemon)"
	done

	out="$WORK/config.out"
	{
		printf '# Generated by %s from UCI package cake-autorate -- DO NOT EDIT.\n' "$PROG"
		printf '# Instance: %s   Log: /var/log/cake-autorate.%s.log\n' "$name" "$name"
		printf '# Regenerate: /etc/init.d/cake-autorate reload\n'
	} > "$out"

	# Pass 1: user + bounded options, in fixed schema order (determinism).
	_schema | while IFS="$TAB" read -r t_name t_type t_managed; do
		[ "$t_managed" = forced ] && continue

		if [ "$t_type" = list ]; then
			# gather list values in file order
			vals=$(awk -F'\t' -v n="$t_name" '$1=="list" && $2==n {print $3}' "$rec")
			[ -n "$vals" ] || continue
			line=$(printf '%s\n' "$vals" | emit_reflectors) || die "$name: $t_name: no valid entries"
			printf '%s\n' "$line" >> "$out"
			continue
		fi

		# scalar: present iff a matching option line exists (empty value allowed)
		line=$(grep -E "^option${TAB}${t_name}${TAB}" "$rec" | tail -n1)
		[ -n "$line" ] || continue
		v=${line#option"${TAB}${t_name}${TAB}"}

		case "$t_type" in
			integer)
				case "$t_name" in
					*_kbps) v=$(normalize_rate "$t_name" "$v") || die "$name: $t_name invalid" ;;
				esac
				kbps=$(coerce_int "$t_name" "$v") || die "$name: $t_name invalid"
				if [ "$t_managed" = bounded ]; then
					range=$(bounded_range "$t_name")
					lo=${range% *}; hi=${range#* }
					[ "$kbps" -lt "$lo" ] && kbps="$lo"
					[ "$kbps" -gt "$hi" ] && kbps="$hi"
				fi
				printf '%s=%s\n' "$t_name" "$kbps" >> "$out"
				;;
			float)
				v=$(coerce_float "$t_name" "$v") || die "$name: $t_name invalid"
				printf '%s=%s\n' "$t_name" "$v" >> "$out"
				;;
			bool)
				v=$(coerce_bool "$t_name" "$v") || die "$name: $t_name invalid"
				printf '%s=%s\n' "$t_name" "$v" >> "$out"
				;;
			string)
				v=$(coerce_string "$t_name" "$v") || die "$name: $t_name invalid"
				printf '%s=%s\n' "$t_name" "$v" >> "$out"
				;;
			*) die "$name: internal: unknown type '$t_type' for '$t_name'" ;;
		esac
	done || exit 1
	# `while | die` runs in a sub-shell under some shells; guard against a
	# silent failure by re-checking below via the coverage assertion.

	# Pass 2: forced options, fixed order, pinned values.
	printf '# --- package-managed (forced) options ---\n' >> "$out"
	for t_name in $FORCED_NAMES; do
		v=$(forced_value "$t_name")
		t_type=$(schema_type "$t_name")
		case "$t_type" in
			string) printf '%s="%s"\n' "$t_name" "$v" >> "$out" ;;
			*)      printf '%s=%s\n'   "$t_name" "$v" >> "$out" ;;
		esac
	done

	# ----- Bidirectional coverage assertion -----
	# expected = present-user-options  UNION  forced-names
	# emitted  = keys actually written to the file
	# shellcheck disable=SC2086  # deliberate word-splitting of the name lists
	expected=$(
		{ printf '%s\n' $present; printf '%s\n' $FORCED_NAMES; } \
			| sed '/^$/d' | sort -u
	)
	emitted=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$out" | sed 's/=.*//')
	line_count=$(printf '%s\n' "$emitted" | sed '/^$/d' | wc -l | tr -d ' ')
	uniq_count=$(printf '%s\n' "$emitted" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')
	if [ "$line_count" != "$uniq_count" ]; then
		rm -f "$out"
		die "$name: coverage failure -- a config key was emitted more than once"
	fi
	emitted=$(printf '%s\n' "$emitted" | sed '/^$/d' | sort -u)
	if [ "$expected" != "$emitted" ]; then
		printf '%s\n' "$expected" > "$WORK/cov.expected"
		printf '%s\n' "$emitted"  > "$WORK/cov.emitted"
		{
			printf '%s: coverage FAILURE for instance %s\n' "$PROG" "$name"
			printf '  only in UCI (dropped, never emitted): %s\n' \
				"$(comm -23 "$WORK/cov.expected" "$WORK/cov.emitted" | tr '\n' ' ')"
			printf '  only emitted (stray, no UCI option):  %s\n' \
				"$(comm -13 "$WORK/cov.expected" "$WORK/cov.emitted" | tr '\n' ' ')"
		} >&2
		rm -f "$out"
		exit 1
	fi

	# Publish.
	if [ "$STDOUT" -eq 1 ]; then
		cat "$out"
		rm -f "$out"
	else
		mkdir -p "$CONFIG_DIR" || die "cannot create $CONFIG_DIR"
		mv "$out" "$CONFIG_DIR/config.$name.sh" || die "cannot write $CONFIG_DIR/config.$name.sh"
		printf '%s\n' "$name" >> "$GENERATED_LIST"
	fi

	local nuser
	nuser=$(printf '%s\n' "$present" | sed '/^$/d' | wc -l | tr -d ' ')
	warn "instance $name: $nuser user option(s) + 4 forced -> $uniq_count keys, all options mapped"
}

# --------------------------------------------------------------------------
# Main.
# --------------------------------------------------------------------------
CONFIG_DIR="${CAKE_AUTORATE_CONFIG_PREFIX:-/etc/cake-autorate}"
SELECT_INSTANCE=''
UCI_FILE=''
STDOUT=0
PRUNE=1

while [ $# -gt 0 ]; do
	case "$1" in
		--config-dir) CONFIG_DIR="${2:-}"; shift 2 ;;
		--instance)   SELECT_INSTANCE="${2:-}"; PRUNE=0; shift 2 ;;
		--uci-file)   UCI_FILE="${2:-}"; shift 2 ;;
		--stdout)     STDOUT=1; PRUNE=0; shift ;;
		--no-prune)   PRUNE=0; shift ;;
		--check-schema) _schema; exit 0 ;;
		-h|--help)    sed -n '2,60p' "$0"; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
done

[ "$STDOUT" -eq 1 ] && [ -z "$SELECT_INSTANCE" ] && die "--stdout requires --instance"

WORK=$(mktemp -d) || die "mktemp failed"
trap 'rm -rf "$WORK"' EXIT INT TERM
GENERATED_LIST="$WORK/generated"
: > "$GENERATED_LIST"

STREAM="$WORK/stream"
if [ -n "$UCI_FILE" ]; then
	[ -f "$UCI_FILE" ] || die "no such UCI file: $UCI_FILE"
	stream_from_file "$UCI_FILE" > "$STREAM"
else
	stream_from_libuci > "$STREAM"
fi

# Split the stream into per-section record files and process each in turn.
cur=''
secfile="$WORK/section.rec"
: > "$secfile"
while IFS="$TAB" read -r kind a b; do
	case "$kind" in
		section)
			[ -n "$cur" ] && process_section "$cur" "$secfile"
			cur="$b"
			: > "$secfile"
			;;
		option|list)
			printf '%s\t%s\t%s\n' "$kind" "$a" "$b" >> "$secfile"
			;;
		'') : ;;
		*) die "internal: unrecognised stream record '$kind'" ;;
	esac
done < "$STREAM"
[ -n "$cur" ] && process_section "$cur" "$secfile"

# Prune stale generated configs (whole-world sync only).
if [ "$PRUNE" -eq 1 ] && [ "$STDOUT" -eq 0 ] && [ -d "$CONFIG_DIR" ]; then
	for f in "$CONFIG_DIR"/config.*.sh; do
		[ -e "$f" ] || continue
		base=${f##*/}; inst=${base#config.}; inst=${inst%.sh}
		if ! grep -qx "$inst" "$GENERATED_LIST"; then
			rm -f "$f" && warn "pruned stale config for disabled/removed instance: $inst"
		fi
	done
fi

exit 0
