'use strict';
'require view';
'require ui';
'require rpc';
'require poll';
'require cake-autorate.live as live';

/*
 * cake-autorate live status view.
 *
 * Polls the rpcd `status` method every few seconds and renders a per-instance
 * table of shaped-vs-achieved rates, load conditions, OWD deltas, run state and
 * uptime. The Start/Stop/Restart controls call the `service` method and then
 * refresh straight away.
 *
 * The JSON-to-row and formatting logic lives in cake-autorate.live, where it is
 * unit-tested under node. This file is rpc/poll/DOM wiring only.
 *
 * Selectors the Playwright suites rely on:
 *   - view root:              #cake-autorate-status
 *   - global controls:        #cake-autorate-controls
 *   - a service button:       button[data-cake-action="start|stop|restart"]
 *                             (global buttons carry data-cake-instance="";
 *                              per-instance buttons carry the instance id)
 *   - a per-instance card:    .cake-instance[data-cake-instance="<inst>"]
 *   - every changing value:   [data-live="1"] (class .cake-live), which the
 *                             visual suite masks. Each also carries
 *                             data-field="<key>" and data-instance so the
 *                             functional suite can assert on it.
 *   - the run-state badge:    .cake-live[data-field="running"]
 *   - the uptime cell:        .cake-live[data-field="uptime_s"]
 *   - the last-update cell:   .cake-live[data-field="datetime"]
 *
 * The metric grid is built with the .table/.tr/.th/.td class set, not bare
 * <table>/<tr>/<td>: LuCI themes style tables through those classes, so the
 * markup has to carry them to get the header row, the row rules and the
 * narrow-screen stacking (see metricTable()).
 */

var POLL_INTERVAL = 3;

var callStatus = rpc.declare({
	object: 'cake-autorate',
	method: 'status',
	params: ['instance'],
	expect: { '': {} }
});

var callService = rpc.declare({
	object: 'cake-autorate',
	method: 'service',
	params: ['action', 'instance'],
	expect: { '': {} }
});

var ACTIONS = [
	{ action: 'start', title: _('Start'), cls: 'positive' },
	{ action: 'stop', title: _('Stop'), cls: 'negative' },
	{ action: 'restart', title: _('Restart'), cls: '' }
];

/* A cell whose value changes on each poll. Everything derived from `status`
 * goes through here, so the visual suite can mask it and the functional suite
 * can find it. */
function liveCell(tag, field, instance, content, extraAttrs) {
	var attrs = {
		'class': 'cake-live',
		'data-live': '1',
		'data-field': field,
		'data-instance': instance
	};
	if (extraAttrs)
		for (var k in extraAttrs)
			attrs[k] = extraAttrs[k];
	return E(tag, attrs, content);
}

function fmtNum(v) {
	return (v == null) ? '—' : String(v);
}

function fmtStr(v) {
	return (v == null || v === '') ? '—' : String(v);
}

var REASON_TEXT = {
	'no-log': _('The service has no log file yet — it is stopped or has not started.'),
	'no-data': _('The daemon is running but has not emitted a SUMMARY line yet — waiting for the first sample.')
};

/* The daemon's three load levels, spelled for humans. An unrecognised token is
 * shown verbatim instead (see live.loadCondition). */
var LOAD_TEXT = {
	'idle': _('Idle'),
	'low': _('Low load'),
	'high': _('High load')
};

/* "High load", or "High load · bufferbloat" while the daemon is flagging one. */
function loadText(v) {
	var lc = live.loadCondition(v);
	if (lc.raw == null)
		return '—';
	var base = lc.key ? LOAD_TEXT[lc.key] : lc.raw;
	return lc.bb ? (base + ' · ' + _('bufferbloat')) : base;
}

/*
 * fieldText(row, field) -- what a data-live cell displays. Used by both the
 * initial card build and the in-place poll update, so the two cannot diverge.
 */
function fieldText(row, field) {
	switch (field) {
		case 'running':   return row.running ? _('running') : _('stopped');
		case 'uptime_s':  return live.formatUptime(row.uptime_s);
		/* The age suffix only appears once the feed has gone quiet -- the daemon
		 * sleeps through an idle link and stops emitting SUMMARY lines, so the
		 * table can legitimately sit still on the last sample. */
		case 'datetime':  return (row.datetime == null || row.datetime === '')
			? '—' : String(row.datetime) + live.sampleAgeSuffix(row.age_s);
		case 'available': return row.running ? _('No data yet') : _('Stopped');
		case 'reason':    return REASON_TEXT[row.reason] || _('No live data available.');
		default:
			return (field.indexOf('load_condition') !== -1)
				? loadText(row[field]) : fmtNum(row[field]);
	}
}

/*
 * cellClass(row, field) -- the class a data-live cell carries, for the fields
 * whose *appearance* tracks the value: the run-state badge and the two load
 * conditions. Returns null for plain value cells, which keep liveCell's default.
 * Paired with fieldText() so the initial build and the in-place poll update stay
 * in step -- updateInPlace() re-applies whatever this returns.
 */
function cellClass(row, field) {
	if (field === 'running')
		return 'cake-live cake-badge ' + (row.running ? 'cake-badge-up' : 'cake-badge-down');

	if (field.indexOf('load_condition') !== -1) {
		var lc = live.loadCondition(row[field]);
		if (lc.raw == null)
			return 'cake-live';
		/* Bufferbloat outranks the level: it is the state worth spotting. */
		if (lc.bb)
			return 'cake-live cake-badge cake-badge-bb';
		return lc.key ? ('cake-live cake-badge cake-badge-' + lc.key) : 'cake-live';
	}

	return null;
}

function runBadge(row) {
	return liveCell('span', 'running', row.instance, fieldText(row, 'running'),
		{ 'class': cellClass(row, 'running') });
}

/* One DL or UL value cell. data-title carries the column name so the theme's
 * narrow-screen rules -- which hide the header row entirely -- can re-label the
 * value in place (luci-theme-bootstrap mobile.css: .td[data-title]::before). */
function valueCell(row, field, title) {
	var cls = cellClass(row, field);
	return E('td', { 'class': 'td cake-col-value', 'data-title': title },
		liveCell('span', field, row.instance, fieldText(row, field),
			cls ? { 'class': cls } : null));
}

/*
 * The metric grid for one instance (DL/UL columns).
 *
 * The .table/.tr/.th/.td class set is what LuCI themes actually style -- a bare
 * <table class="table"> picks up almost none of it -- and tr.table-titles is the
 * themed header row. See luci-theme-bootstrap cascade.css "Tables.less".
 */
function metricTable(row) {
	var dl = _('Download'), ul = _('Upload');

	var rows = [
		E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th cake-col-metric' }, _('Metric')),
			E('th', { 'class': 'th cake-col-value' }, dl),
			E('th', { 'class': 'th cake-col-value' }, ul)
		])
	];

	live.STATUS_FIELDS.forEach(function (f) {
		/* Unit rides along as a muted span rather than "(Kbit/s)" inside the bold
		 * label, so the metric names line up as the thing you scan. */
		var label = [ _(f.label) ];
		if (f.unit)
			label.push(E('span', { 'class': 'cake-unit' }, ' ' + f.unit));

		rows.push(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td cake-col-metric cake-metric-label' }, label),
			valueCell(row, f.dl, dl),
			valueCell(row, f.ul, ul)
		]));
	});

	return E('table', { 'class': 'table cake-metric-table' }, rows);
}

/* One instance card: header (name + run badge + uptime), controls, and either
 * the metric grid or an "unavailable" notice. */
function instanceCard(row, onService) {
	var body;
	if (row.available) {
		body = metricTable(row);
	}
	else {
		body = E('div', { 'class': 'cake-unavailable' }, [
			liveCell('span', 'available', row.instance, fieldText(row, 'available'),
				{ 'class': 'cake-live cake-nodata' }),
			' — ',
			liveCell('span', 'reason', row.instance, fieldText(row, 'reason'))
		]);
	}

	var header = E('div', { 'class': 'cake-instance-head' }, [
		E('h3', {}, [ _('Instance') + ': ', E('span', { 'class': 'cake-instance-name' }, row.instance) ]),
		E('div', { 'class': 'cake-instance-state' }, [
			runBadge(row),
			' ',
			E('span', {}, [
				_('Uptime') + ': ',
				liveCell('span', 'uptime_s', row.instance, fieldText(row, 'uptime_s'))
			]),
			E('span', { 'class': 'cake-lastupdate' }, [
				' · ' + _('Last update') + ': ',
				liveCell('span', 'datetime', row.instance, fieldText(row, 'datetime'))
			])
		])
	]);

	var controls = E('div', { 'class': 'cbi-section-actions cake-instance-controls' },
		ACTIONS.map(function (a) {
			return E('button', {
				'class': 'cbi-button' + (a.cls ? ' cbi-button-' + a.cls : ''),
				'data-cake-action': a.action,
				'data-cake-instance': row.instance,
				'click': ui.createHandlerFn({}, onService, a.action, row.instance)
			}, a.title);
		}));

	return E('div', {
		'class': 'cbi-section cake-instance',
		'data-cake-instance': row.instance
	}, [ header, controls, body ]);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	render: function () {
		var self = this;

		/* Body container that the poll refreshes in place. */
		var bodyEl = E('div', { 'id': 'cake-autorate-status-body' });

		/* The page structure depends only on which instances exist and whether
		 * each has data (metric table vs notice). Run state and every value are
		 * updated in place. */
		var lastSig = null;
		function structuralSig(rows) {
			if (!rows.length)
				return 'empty';
			return rows.map(function (r) {
				return r.instance + ':' + (r.available ? 'a' : 'u');
			}).join('|');
		}

		/* Update just the data-live cells for an unchanged structure, preserving
		 * text selection / focus and avoiding a full DOM rebuild every 3s. */
		function updateInPlace(rows) {
			rows.forEach(function (row) {
				var sel = '[data-live="1"][data-instance="' + row.instance + '"]';
				bodyEl.querySelectorAll(sel).forEach(function (c) {
					var f = c.getAttribute('data-field');
					c.textContent = fieldText(row, f);
					var cls = cellClass(row, f);
					if (cls != null)
						c.className = cls;
				});
			});
		}

		function renderRows(resp) {
			var rows = live.statusRows(resp);
			var sig = structuralSig(rows);

			if (sig === lastSig && sig !== 'empty') {
				updateInPlace(rows);
				return;
			}
			lastSig = sig;

			var nodes = [];
			if (!rows.length) {
				nodes.push(E('div', { 'class': 'cbi-section' }, [
					E('p', {}, _('No enabled cake-autorate instances. Enable an instance on the Configuration tab, then Start it below.'))
				]));
			}
			else {
				rows.forEach(function (row) {
					nodes.push(instanceCard(row, handleService));
				});
			}

			bodyEl.replaceChildren.apply(bodyEl, nodes);
		}

		function refresh() {
			return callStatus(null).then(renderRows).catch(function (e) {
				// Replace the whole body with the error, and forget the last
				// structure so the next successful poll does a full rebuild rather
				// than trying an in-place update against the error DOM.
				lastSig = null;
				bodyEl.replaceChildren(E('div', { 'class': 'alert-message warning' },
					_('Could not read status: %s').format(e && e.message ? e.message : e)));
			});
		}

		/* Service button handler: call `service`, notify, then refresh now. */
		function handleService(action, instance) {
			return callService(action, instance || '').then(function (res) {
				var code = (res && typeof res.code !== 'undefined') ? res.code : '?';
				if (String(code) === '0')
					ui.addNotification(null,
						E('p', {}, _('%s %s succeeded.').format(action, instance || _('(all instances)'))),
						'info');
				else
					ui.addNotification(null,
						E('p', {}, _('%s %s returned exit code %s.').format(action, instance || _('(all instances)'), code)),
						'warning');
				return refresh();
			}).catch(function (e) {
				ui.addNotification(null,
					E('p', {}, _('%s failed: %s').format(action, e && e.message ? e.message : e)),
					'error');
			});
		}

		var globalControls = E('div', { 'id': 'cake-autorate-controls', 'class': 'cbi-section' }, [
			E('h3', {}, _('Service control (all instances)')),
			E('div', { 'class': 'cbi-section-actions' },
				ACTIONS.map(function (a) {
					return E('button', {
						'class': 'cbi-button' + (a.cls ? ' cbi-button-' + a.cls : ''),
						'data-cake-action': a.action,
						'data-cake-instance': '',
						'click': ui.createHandlerFn({}, handleService, a.action, '')
					}, a.title);
				}))
		]);

		return refresh().then(function () {
			poll.add(refresh, POLL_INTERVAL);

			return E('div', { 'id': 'cake-autorate-status', 'class': 'cbi-map' }, [
				E('style', { 'type': 'text/css' },
					'#cake-autorate-status .cake-instance{margin-bottom:1em;}' +
					'.cake-instance-head{display:flex;flex-wrap:wrap;gap:.5em 1.5em;align-items:baseline;}' +
					'.cake-instance-head h3{margin:0;}' +
					'.cake-instance-name{font-family:monospace;}' +
					'.cake-badge{display:inline-block;padding:.1em .5em;border-radius:.3em;' +
						'font-size:90%;white-space:nowrap;}' +
					'.cake-badge-up{background:#4caf50;color:#fff;}' +
					'.cake-badge-down{background:#9e9e9e;color:#fff;}' +
					/* Load levels: idle is unremarkable, high load is normal-and-busy,
					 * bufferbloat is the one worth catching your eye. */
					'.cake-badge-idle{background:#9e9e9e;color:#fff;}' +
					'.cake-badge-low{background:#4caf50;color:#fff;}' +
					'.cake-badge-high{background:#1e88e5;color:#fff;}' +
					'.cake-badge-bb{background:#f57c00;color:#fff;}' +
					/* Five short rows do not need the theme's full-width table: cap it
					 * so DL and UL sit next to their labels instead of a screen apart.
					 * Same specificity as the theme's own ".table .td", and this style
					 * block comes later, so these win. */
					'.cake-metric-table{width:auto;max-width:34em;}' +
					'.cake-metric-table .th,.cake-metric-table .td{padding:.35em .75em;}' +
					'.cake-metric-table .cake-col-value{width:8em;' +
						'font-variant-numeric:tabular-nums;}' +
					'.cake-unit{font-weight:normal;opacity:.7;}' +
					'.cake-metric-label{font-weight:bold;}' +
					'.cake-instance-controls{margin:.5em 0;display:flex;gap:.5em;flex-wrap:wrap;}' +
					'.cake-unavailable{padding:.5em 0;opacity:.85;}' +
					'.cake-lastupdate{opacity:.75;font-size:90%;}'),
				E('h2', {}, _('CAKE Autorate — Live status')),
				E('p', {}, _('Per-instance live readout, refreshed every %d seconds from the running daemon. Dashed values mean no data has been parsed yet.').format(POLL_INTERVAL)),
				globalControls,
				bodyEl
			]);
		});
	}
});
