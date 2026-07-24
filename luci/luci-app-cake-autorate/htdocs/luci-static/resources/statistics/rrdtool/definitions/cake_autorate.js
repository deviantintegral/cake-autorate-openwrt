/* Licensed to the public under the Apache License 2.0. */

'use strict';
'require baseclass';

/*
 * luci-app-statistics graph definition for cake-autorate  --  owned by task 6.
 *
 * luci-app-statistics auto-loads a definition from
 *   .../statistics/rrdtool/definitions/<plugin>.js
 * where <plugin> is the collectd plugin name that produced the RRDs. The
 * collectd exec reader (cake-autorate-collectd.sh) emits PUTVAL lines under the
 * plugin name "cake_autorate", so this file MUST be named cake_autorate.js.
 * That also sidesteps a collision with luci-app-statistics' own tail.js: the
 * data comes in under a distinct plugin name, not "tail"/"exec".
 *
 * The exec reader sets the collectd plugin INSTANCE to the cake-autorate
 * instance id (e.g. "primary"), so per_instance:true draws one panel per WAN.
 *
 * Metrics (stock collectd types, so no custom types.db is required):
 *   bitrate-dl_achieved / bitrate-ul_achieved   achieved rate/direction (kbit/s)
 *   bitrate-dl_shaper   / bitrate-ul_shaper      CAKE shaper rate/direction (kbit/s)
 *   gauge-dl_owd_delta_us / gauge-ul_owd_delta_us  avg one-way-delay delta (us, unbounded)
 *   gauge-dl_load       / gauge-ul_load          load/bufferbloat state (0/1/2, +10 = bufferbloat)
 */

return baseclass.extend({
	title: _('CAKE Autorate'),

	rrdargs(graph, host, plugin, plugin_instance, dtype) {
		/*
		 * Shaper vs achieved rate. Upload series are flipped below the axis in
		 * the classic SQM mirror layout so download/upload read at a glance.
		 */
		const rates = {
			per_instance: true,
			title: "%H: CAKE Autorate rates on %pi",
			vlabel: "kbit/s",
			number_format: "%5.0lf",

			data: {
				instances: {
					bitrate: [ "dl_shaper", "dl_achieved", "ul_shaper", "ul_achieved" ]
				},

				options: {
					bitrate_dl_shaper: {
						color: "0000ff",
						title: "Shaper   (DL)",
						noarea: true,
						overlay: true
					},
					bitrate_dl_achieved: {
						color: "00b0ff",
						title: "Achieved (DL)",
						noarea: false,
						overlay: true
					},
					bitrate_ul_shaper: {
						color: "ff0000",
						title: "Shaper   (UL)",
						flip: true,
						noarea: true,
						overlay: true
					},
					bitrate_ul_achieved: {
						color: "ff8000",
						title: "Achieved (UL)",
						flip: true,
						noarea: false,
						overlay: true
					}
				}
			}
		};

		/*
		 * One-way-delay delta from baseline -- the bufferbloat signal the daemon
		 * reacts to. Upload flipped below the axis.
		 */
		const owd = {
			per_instance: true,
			title: "%H: CAKE Autorate OWD delta on %pi",
			vlabel: "us",
			number_format: "%5.0lf",

			data: {
				instances: {
					gauge: [ "dl_owd_delta_us", "ul_owd_delta_us" ]
				},

				options: {
					gauge_dl_owd_delta_us: {
						color: "00b000",
						title: "OWD delta (DL)",
						overlay: true
					},
					gauge_ul_owd_delta_us: {
						color: "b000b0",
						title: "OWD delta (UL)",
						flip: true,
						overlay: true
					}
				}
			}
		};

		/*
		 * Load / bufferbloat state gauge.
		 *   0 = idle, 1 = low, 2 = high; +10 when bufferbloat is flagged
		 *   (10/11/12), -1 = unknown.
		 */
		const load = {
			per_instance: true,
			title: "%H: CAKE Autorate load state on %pi",
			vlabel: "state",
			number_format: "%4.0lf",
			y_min: "-1",

			data: {
				instances: {
					gauge: [ "dl_load", "ul_load" ]
				},

				options: {
					gauge_dl_load: {
						color: "00b000",
						title: "Load state (DL)",
						noarea: true,
						overlay: true
					},
					gauge_ul_load: {
						color: "b000b0",
						title: "Load state (UL)",
						noarea: true,
						overlay: true
					}
				}
			}
		};

		return [ rates, owd, load ];
	}
});
