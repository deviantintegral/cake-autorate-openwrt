#!/usr/bin/env node
'use strict';

/*
 * Unit tests for the logic we wrote in
 *   htdocs/luci-static/resources/cake-autorate/options.js
 *
 * What this covers:
 *   - coverageReport(): the 66-option / per-group check, including that it
 *     really does fail on a bad set rather than rubber-stamping it.
 *   - optionMatches(): the search box's matching rule.
 *   - datatypeFor(): the type/bounds -> LuCI datatype mapping.
 *   - OPTIONS names are exactly the 66 names in docs/uci-option-schema.tsv.
 *
 * Not covered here: the form.Map / TypedSection / tab declarations and the DOM
 * show/hide glue in overview.js. Those are LuCI framework wiring, exercised end
 * to end by the Playwright suites instead.
 *
 * options.js is a LuCI class file (it returns baseclass.extend(...)), so we
 * load the shipped source with a stub `baseclass` whose extend() hands back the
 * plain object.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const modPath = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'cake-autorate', 'options.js');
const tsvPath = path.join(repoRoot, 'docs', 'uci-option-schema.tsv');

function loadModule() {
	const src = fs.readFileSync(modPath, 'utf8');
	const stubBase = { extend: function (o) { return o; } };
	// eslint-disable-next-line no-new-func
	const factory = new Function('window', 'document', 'L', 'baseclass', src);
	return factory(undefined, undefined, undefined, stubBase);
}

function tsvOptionNames() {
	return fs.readFileSync(tsvPath, 'utf8')
		.split('\n')
		.filter(function (l) { return l && l[0] !== '#'; })
		.map(function (l) { return l.split('\t')[0]; })
		.filter(Boolean);
}

let passed = 0;
function test(name, fn) {
	fn();
	passed++;
	console.log('ok - ' + name);
}

const mod = loadModule();

test('coverageReport passes for the shipped OPTIONS', function () {
	const r = mod.coverageReport(mod.OPTIONS);
	assert.strictEqual(r.ok, true, 'errors: ' + r.errors.join('; '));
	assert.strictEqual(r.total, 66);
});

test('coverageReport reports the expected per-group split', function () {
	const r = mod.coverageReport(mod.OPTIONS);
	assert.deepStrictEqual(r.counts, {
		essentials: 8, shaper: 11, pingers: 5, reflectors: 10,
		detection: 10, idle: 8, logging: 14
	});
});

test('coverageReport FAILS when an option is missing', function () {
	const r = mod.coverageReport(mod.OPTIONS.slice(0, 65));
	assert.strictEqual(r.ok, false);
	assert.ok(r.errors.some(function (e) { return /65/.test(e); }));
});

test('coverageReport FAILS on a duplicate option', function () {
	const dupes = mod.OPTIONS.slice(0, 65).concat([mod.OPTIONS[0]]);
	const r = mod.coverageReport(dupes);
	assert.strictEqual(r.ok, false);
	assert.ok(r.errors.some(function (e) { return /duplicate/.test(e); }));
});

test('coverageReport FAILS on an unexpected group', function () {
	const bad = mod.OPTIONS.slice(0, 65).concat([{ name: 'x_decorative', group: 'bogus', type: 'bool' }]);
	const r = mod.coverageReport(bad);
	assert.strictEqual(r.ok, false);
	assert.ok(r.errors.some(function (e) { return /bogus/.test(e); }));
});

test('optionMatches: empty query matches everything', function () {
	assert.strictEqual(mod.optionMatches('', 'debug', 'Debug'), true);
	assert.strictEqual(mod.optionMatches('   ', 'debug', 'Debug'), true);
	assert.strictEqual(mod.optionMatches(null, 'debug', 'Debug'), true);
});

test('optionMatches: matches on UCI name substring, case-insensitively', function () {
	assert.strictEqual(mod.optionMatches('SHAPER', 'max_dl_shaper_rate_kbps', 'Max DL rate'), true);
	assert.strictEqual(mod.optionMatches('kbps', 'max_dl_shaper_rate_kbps', 'Max DL rate'), true);
});

test('optionMatches: matches on title substring', function () {
	assert.strictEqual(mod.optionMatches('reflector', 'reflectors', 'Reflector pool'), true);
});

test('optionMatches: no match returns false', function () {
	assert.strictEqual(mod.optionMatches('zzz_nope', 'debug', 'Debug'), false);
});

test('datatypeFor: bool/string/list have no datatype', function () {
	assert.strictEqual(mod.datatypeFor({ type: 'bool' }), null);
	assert.strictEqual(mod.datatypeFor({ type: 'string' }), null);
	assert.strictEqual(mod.datatypeFor({ type: 'list' }), null);
});

test('datatypeFor: plain integer/float', function () {
	assert.strictEqual(mod.datatypeFor({ type: 'integer' }), 'uinteger');
	assert.strictEqual(mod.datatypeFor({ type: 'float' }), 'ufloat');
});

test('datatypeFor: bounds compose into and(...) expressions', function () {
	assert.strictEqual(mod.datatypeFor({ type: 'float', lo: 0, hi: 1 }), 'and(ufloat,range(0,1))');
	assert.strictEqual(mod.datatypeFor({ type: 'integer', lo: 1 }), 'and(uinteger,min(1))');
	assert.strictEqual(mod.datatypeFor({ type: 'float', lo: 1 }), 'and(ufloat,min(1))');
});

test('OPTIONS names are exactly the 66 names in uci-option-schema.tsv', function () {
	const fromView = mod.OPTIONS.map(function (o) { return o.name; }).sort();
	const fromTsv = tsvOptionNames().sort();
	assert.strictEqual(fromView.length, 66);
	assert.strictEqual(fromTsv.length, 66);
	assert.deepStrictEqual(fromView, fromTsv);
});

/* --- checkRateOrder: the min <= base <= max rule the Essentials help states -- */

test('checkRateOrder: a consistent trio passes', function () {
	assert.strictEqual(mod.checkRateOrder(2000, 5000, 40000), null);
	assert.strictEqual(mod.checkRateOrder('2000', '5000', '40000'), null);
	assert.strictEqual(mod.checkRateOrder(5000, 5000, 5000), null, 'equal values are legal');
});

test('checkRateOrder: min above base is rejected', function () {
	const err = mod.checkRateOrder(9000, 5000, 40000);
	assert.ok(err);
	assert.strictEqual(err.code, 'min-gt-base');
	assert.strictEqual(err.a, 9000);
	assert.strictEqual(err.b, 5000);
});

test('checkRateOrder: max below base is rejected', function () {
	const err = mod.checkRateOrder(2000, 5000, 4000);
	assert.ok(err);
	assert.strictEqual(err.code, 'max-lt-base');
});

test('checkRateOrder: min above max is rejected when base is absent', function () {
	const err = mod.checkRateOrder(9000, '', 4000);
	assert.ok(err);
	assert.strictEqual(err.code, 'min-gt-max');
});

test('checkRateOrder: an empty or non-numeric field never invents an error', function () {
	// rmempty is true on these fields; a blank means "use the daemon default",
	// so a half-filled trio must stay valid rather than block the save.
	assert.strictEqual(mod.checkRateOrder('', 5000, ''), null);
	assert.strictEqual(mod.checkRateOrder(null, null, null), null);
	assert.strictEqual(mod.checkRateOrder(undefined, 5000, 40000), null);
	assert.strictEqual(mod.checkRateOrder('abc', 5000, 40000), null);
	assert.strictEqual(mod.checkRateOrder('  ', '  ', '  '), null);
});

test('checkRateOrder: covers both directions via RATE_TRIOS metadata', function () {
	const names = mod.OPTIONS.map(function (o) { return o.name; });
	assert.strictEqual(mod.RATE_TRIOS.length, 2);
	mod.RATE_TRIOS.forEach(function (t) {
		[t.min, t.base, t.max].forEach(function (n) {
			assert.ok(names.indexOf(n) !== -1, n + ' must be a real option');
		});
	});
});

/* --- instanceNameSuggestions: "Add instance" datalist ---------------------- */

test('instanceNameSuggestions: sanitizes devices UCI would reject', function () {
	assert.deepStrictEqual(
		mod.instanceNameSuggestions(['pppoe-wan', 'eth0.2', 'wan.835'], []),
		['pppoe_wan', 'eth0_2', 'wan_835']);
});

test('instanceNameSuggestions: drops names already configured', function () {
	assert.deepStrictEqual(mod.instanceNameSuggestions(['eth1', 'eth2'], ['eth1']), ['eth2']);
});

test('instanceNameSuggestions: dedupes collisions after sanitizing', function () {
	assert.deepStrictEqual(mod.instanceNameSuggestions(['eth0.2', 'eth0-2'], []), ['eth0_2']);
});

test('instanceNameSuggestions: no SQM means no suggestions, not a bad list', function () {
	assert.deepStrictEqual(mod.instanceNameSuggestions([], []), []);
	assert.deepStrictEqual(mod.instanceNameSuggestions(undefined, undefined), []);
	assert.deepStrictEqual(mod.instanceNameSuggestions(['---'], []), []);
});

console.log('\n' + passed + ' tests passed');
