'use strict';
'require baseclass';

/*
 * SKELETON -- owned by task 6 (statistics / collectd integration).
 *
 * luci-app-statistics loads contributed graph definitions from
 *   /www/luci-static/resources/statistics/rrdtool/definitions/<plugin>.js
 * where <plugin> is the collectd plugin (or plugin instance) name that
 * produced the RRDs.
 *
 * OPEN DECISION for task 6: the data is produced by collectd's `tail` plugin,
 * and luci-app-statistics already ships its own `tail.js`. Overriding that file
 * would collide with luci-app-statistics, so task 6 must either
 *   (a) keep this file named after a distinct plugin/instance name, or
 *   (b) contribute the graph upstream to luci-app-statistics instead.
 * Rename this file if (a) resolves to a different name.
 */

return baseclass.extend({
	title: _('CAKE Autorate'),

	rrdargs: function (graph, host, plugin, plugin_instance, dtype) {
		return [];
	}
});
