/* Licensed to the public under the Apache License 2.0. */

'use strict';
'require baseclass';

/*
 * luci-app-statistics graph definition for cake-autorate.
 *
 * luci-app-statistics loads a definition from
 *   .../statistics/rrdtool/definitions/<plugin>.js
 * where <plugin> is the collectd plugin name that produced the RRDs. The exec
 * reader (cake-autorate-collectd.sh) emits PUTVAL lines under the plugin name
 * "cake_autorate", so this file must be named cake_autorate.js. Using our own
 * plugin name also keeps the data clear of luci-app-statistics' own tail.js.
 *
 * The reader sets the collectd plugin INSTANCE to the cake-autorate instance id
 * (e.g. "primary"). One panel per WAN needs nothing from us: luci-app-statistics
 * calls rrdargs() once per plugin instance already, and "%pi" in a title expands
 * to that instance id.
 *
 * Every graph below therefore sets `per_instance: false`. That flag does NOT
 * mean "one panel per plugin instance" -- it means "one panel per DATA instance"
 * (the type-instance half of a `<type>-<type_instance>.rrd` filename), and
 * rrdtool.js only reads our `data.instances` list on the false branch:
 *
 *     if (!opts.per_instance) {
 *         if (L.isObject(opts.data.instances) && Array.isArray(opts.data.instances[dt]))
 *             data_instances = opts.data.instances[dt];
 *         ...
 *     }
 *     if (!Array.isArray(data_instances) || data_instances.length == 0)
 *         data_instances = [ '' ];
 *
 * Set it true and the lists below are skipped entirely: every panel collapses to
 * the unnamed instance '' (legends read "dt=bitrate/di=(nil)/ds=value"), and the
 * outer loop fans each definition out across the data instances of its FIRST
 * source's type. That turned these 3 graphs into 12 -- 4 bitrate panels and,
 * because `owd` and `load` both lead with `gauge`, two identical sets of 4 gauge
 * panels, each drawing a single unlabelled series. Upstream's sqm.js spells the
 * false out for the same reason; so do we.
 *
 * Metrics (stock collectd types, so there is no types.db to ship):
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
			per_instance: false,
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
						title: "Shaper   (download)",
						noarea: true,
						overlay: true
					},
					bitrate_dl_achieved: {
						color: "00b0ff",
						title: "Achieved (download)",
						noarea: false,
						overlay: true
					},
					bitrate_ul_shaper: {
						color: "ff0000",
						title: "Shaper   (upload)",
						flip: true,
						noarea: true,
						overlay: true
					},
					bitrate_ul_achieved: {
						color: "ff8000",
						title: "Achieved (upload)",
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
			per_instance: false,
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
						title: "OWD delta (download)",
						overlay: true
					},
					gauge_ul_owd_delta_us: {
						color: "b000b0",
						title: "OWD delta (upload)",
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
			per_instance: false,
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
						title: "Load state (download)",
						noarea: true,
						overlay: true
					},
					gauge_ul_load: {
						color: "b000b0",
						title: "Load state (upload)",
						noarea: true,
						overlay: true
					}
				}
			}
		};

		return [ rates, owd, load ];
	}
});
