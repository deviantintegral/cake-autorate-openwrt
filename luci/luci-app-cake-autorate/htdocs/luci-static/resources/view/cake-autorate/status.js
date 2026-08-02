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
 *   - the setup banner:       #cake-autorate-setup[data-cake-setup="warn|error"]
 *                             (absent entirely once SQM is shaping with CAKE);
 *                             its steps are ol.cake-setup-steps > li[data-done]
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

/* Preconditions, not live data: SQM's own setup is what decides whether this
 * page can ever show a number. Fetched once per render and after a service
 * action, NOT on the 3s poll -- it shells out to tc. */
var callSqmInterfaces = rpc.declare({
	object: 'cake-autorate',
	method: 'sqm_interfaces',
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

/*
 * reasonText(row) -- REASON_TEXT, except for no-interface, which names the
 * offending device. That case is not a transient "waiting": the daemon is parked
 * in upstream's verify_ifs_up() and will never emit a sample until the device
 * exists, so it must not be worded like the no-data one above.
 */
function reasonText(row) {
	if (row.reason === 'no-interface')
		return _('Parked: the configured interface %s does not exist on this router, so the daemon is waiting for it and will never produce a sample. Set the interfaces to the devices SQM shapes.')
			.format(row.missing_ifs || (row.dl_if + ', ' + row.ul_if));
	return REASON_TEXT[row.reason] || _('No live data available.');
}

/*
 * fieldText(row, field) -- what a data-live cell displays. Used by both the
 * initial card build and the in-place poll update, so the two cannot diverge.
 */
function fieldText(row, field) {
	switch (field) {
		case 'running':   return row.running ? _('running') : _('stopped');
		case 'uptime_s':  return live.formatUptime(row.uptime_s);
		case 'datetime':  return fmtStr(row.datetime);
		case 'available': return row.running
			? (row.reason === 'no-interface' ? _('Not shaping') : _('No data yet'))
			: _('Stopped');
		case 'reason':    return reasonText(row);
		default:
			return (field.indexOf('load_condition') !== -1)
				? fmtStr(row[field]) : fmtNum(row[field]);
	}
}

function runBadgeClass(row) {
	return 'cake-live cake-badge ' + (row.running ? 'cake-badge-up' : 'cake-badge-down');
}

function runBadge(row) {
	return liveCell('span', 'running', row.instance, fieldText(row, 'running'),
		{ 'class': runBadgeClass(row) });
}

/* The metric grid for one instance (DL/UL columns). */
function metricTable(row) {
	var rows = [
		E('tr', {}, [
			E('th', {}, _('Metric')),
			E('th', {}, _('Download')),
			E('th', {}, _('Upload'))
		])
	];

	live.STATUS_FIELDS.forEach(function (f) {
		var label = f.unit ? (_(f.label) + ' (' + f.unit + ')') : _(f.label);
		rows.push(E('tr', {}, [
			E('td', { 'class': 'cake-metric-label' }, label),
			E('td', {}, liveCell('span', f.dl, row.instance, fieldText(row, f.dl))),
			E('td', {}, liveCell('span', f.ul, row.instance, fieldText(row, f.ul)))
		]));
	});

	return E('table', { 'class': 'table cake-metric-table' }, rows);
}

/*
 * setupBanner(state) -- the numbered "what to do next" list, or null once every
 * precondition is met (a healthy router should not carry a permanent banner).
 *
 * This is the answer to the most common first-run report: the service says
 * "running", the page says "waiting for the first sample", and nothing ever
 * arrives -- because SQM was never set up and there is no CAKE qdisc to adjust.
 */
function setupBanner(state) {
	if (state.ok)
		return null;

	return E('div', {
		'id': 'cake-autorate-setup',
		'class': 'alert-message ' + (state.level === 'warn' ? 'warning' : 'error'),
		'data-cake-setup': state.level
	}, [
		E('h3', {}, _('CAKE Autorate has nothing to shape yet')),
		E('p', {}, state.title),
		E('p', {}, _('CAKE Autorate does not create the queue — it adjusts the bandwidth of a CAKE qdisc that SQM attaches. Remaining steps:')),
		E('ol', { 'class': 'cake-setup-steps' }, state.steps.map(function (step) {
			return E('li', { 'data-done': step.done ? '1' : '0' }, [
				E('span', { 'class': 'cake-step-mark' }, step.done ? '✓ ' : '☐ '),
				step.text
			]);
		})),
		E('p', {}, E('a', {
			'class': 'cbi-button cbi-button-action',
			'href': L.url(state.link)
		}, _('Open SQM QoS settings')))
	]);
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

		/* Setup/precondition container. Refreshed on render and after a service
		 * action -- not on the 3s poll, since it shells out to tc and its answer
		 * only changes when someone edits SQM. */
		var setupEl = E('div', { 'id': 'cake-autorate-setup-body' });

		function refreshSetup() {
			return callSqmInterfaces().then(function (sqm) {
				var node = setupBanner(live.setupState(sqm));
				setupEl.replaceChildren.apply(setupEl, node ? [node] : []);
			}).catch(function () {
				/* A failed precondition probe must never hide the status table:
				 * drop the banner and let the per-instance rows speak. */
				setupEl.replaceChildren();
			});
		}

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
					if (f === 'running')
						c.className = runBadgeClass(row);
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
				return Promise.all([refresh(), refreshSetup()]);
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

		return Promise.all([refresh(), refreshSetup()]).then(function () {
			poll.add(refresh, POLL_INTERVAL);

			return E('div', { 'id': 'cake-autorate-status', 'class': 'cbi-map' }, [
				E('style', { 'type': 'text/css' },
					'#cake-autorate-status .cake-instance{margin-bottom:1em;}' +
					'.cake-instance-head{display:flex;flex-wrap:wrap;gap:.5em 1.5em;align-items:baseline;}' +
					'.cake-instance-head h3{margin:0;}' +
					'.cake-instance-name{font-family:monospace;}' +
					'.cake-badge{padding:.1em .5em;border-radius:.3em;font-size:90%;}' +
					'.cake-badge-up{background:#4caf50;color:#fff;}' +
					'.cake-badge-down{background:#9e9e9e;color:#fff;}' +
					'.cake-metric-table td,.cake-metric-table th{padding:.25em .75em;}' +
					'.cake-metric-label{font-weight:bold;}' +
					'.cake-instance-controls{margin:.5em 0;display:flex;gap:.5em;flex-wrap:wrap;}' +
					'.cake-unavailable{padding:.5em 0;opacity:.85;}' +
					'.cake-lastupdate{opacity:.75;font-size:90%;}' +
					'#cake-autorate-setup h3{margin-top:0;}' +
					'.cake-setup-steps{margin:.5em 0 .75em 1.5em;}' +
					'.cake-setup-steps li{margin:.25em 0;}' +
					'.cake-setup-steps li[data-done="1"]{opacity:.6;}' +
					'.cake-step-mark{font-family:monospace;}'),
				E('h2', {}, _('CAKE Autorate — Live status')),
				E('p', {}, _('Per-instance live readout, refreshed every %d seconds from the running daemon. Dashed values mean no data has been parsed yet.').format(POLL_INTERVAL)),
				setupEl,
				globalControls,
				bodyEl
			]);
		});
	}
});
