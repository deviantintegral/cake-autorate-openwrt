'use strict';
'require view';
'require ui';

/*
 * SKELETON -- owned by task 7.
 *
 * Task 2 created this placeholder so the menu entry resolves and the package
 * has a view to install. Task 7 replaces it with the real form + status view,
 * built strictly from docs/upstream-option-inventory.md (66 options, exact
 * upstream names, float vs integer types honoured).
 *
 * Display the PACKAGE version (3.2.2), not the daemon's self-reported
 * cake_autorate_version -- upstream hard-codes a stale "3.2.1" at tag v3.2.2.
 */

return view.extend({
	render: function () {
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('CAKE Autorate')),
			E('p', { 'class': 'cbi-map-descr' },
				_('The cake-autorate configuration interface is not installed yet.'))
		]);
	}
});
