#!/usr/bin/env node
'use strict';
/*
 * Builds a gallery of the UI screenshots for a human to look through.
 *
 * Collects the committed full-page baseline PNGs the visual suite writes
 * (tests/ui/visual/<spec>.spec.js-snapshots/<name>-<project>-<platform>.png) and
 * emits one self-contained, labelled index.html, so a maintainer can review
 * every page and state from a CI artifact without a device or diff tooling.
 *
 * The gallery is produced whether the visual diff passed or failed, because it
 * reads the baselines themselves -- which exist as soon as the suite has run
 * once with --update-snapshots. Run it after the visual project in CI and upload
 * the output dir as an artifact.
 *
 * Output (gitignored build artifact):
 *   tests/ui/visual/gallery/index.html
 *   tests/ui/visual/gallery/images/*.png   (copies, so the artifact is standalone)
 *
 * Usage:
 *   node generate-gallery.js [--src <visualDir>] [--out <galleryDir>]
 */
const fs = require('fs');
const path = require('path');

const VISUAL_DIR = __dirname;

function parseArgs(argv) {
  const args = { src: VISUAL_DIR, out: path.join(VISUAL_DIR, 'gallery') };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src') args.src = path.resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
  }
  return args;
}

/* Recursively collect every *.png under any *-snapshots directory below `root`. */
function collectBaselines(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_e) { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.png') && dir.endsWith('-snapshots')) {
        out.push(p);
      }
    }
  }
  walk(root);
  return out.sort();
}

/* Strip Playwright's trailing -<project>-<platform> from a snapshot stem. */
function snapshotStem(file) {
  return path.basename(file, '.png').replace(/-[a-z0-9]+-[a-z0-9]+$/i, '');
}

/* Labels and grouping for each known snapshot stem. An unknown stem still shows
 * up under a tidied-up name, so a newly added spec never drops out unnoticed. */
const LABELS = {
  'status-view': { group: 'Live status view', label: 'Status view — two running instances (live cells masked)' },
  'config-multi-instance': { group: 'Configuration form', label: 'Multi-instance overview (primary + secondary)' },
  'config-single-instance': { group: 'Configuration form', label: 'Single populated instance (Essentials tab)' },
  'config-tab-essentials': { group: 'Configuration form — group tabs', label: 'Tab: Essentials' },
  'config-tab-shaper': { group: 'Configuration form — group tabs', label: 'Tab: Shaper rates & response' },
  'config-tab-pingers': { group: 'Configuration form — group tabs', label: 'Tab: Pingers' },
  'config-tab-reflectors': { group: 'Configuration form — group tabs', label: 'Tab: Reflectors' },
  'config-tab-detection': { group: 'Configuration form — group tabs', label: 'Tab: Delay & bufferbloat detection' },
  'config-tab-idle': { group: 'Configuration form — group tabs', label: 'Tab: Idle, sleep & stalls' },
  'config-tab-logging': { group: 'Configuration form — group tabs', label: 'Tab: Logging & output' },
  'config-empty': { group: 'Configuration form', label: 'Empty config (no instances)' },
  'config-post-save-apply': { group: 'Configuration form', label: 'Post Save & Apply (new instance committed)' },
};

const GROUP_ORDER = [
  'Live status view',
  'Configuration form',
  'Configuration form — group tabs',
  'Other',
];

function humanize(stem) {
  return stem.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function main() {
  const { src, out } = parseArgs(process.argv);
  const imagesDir = path.join(out, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const baselines = collectBaselines(src);

  // Copy each baseline into the gallery and build its display record.
  const records = baselines.map((file) => {
    const fname = path.basename(file);
    const stem = snapshotStem(file);
    const meta = LABELS[stem] || { group: 'Other', label: humanize(stem) };
    const bytes = fs.statSync(file).size;
    fs.copyFileSync(file, path.join(imagesDir, fname));
    return {
      stem, fname, bytes,
      group: meta.group,
      label: meta.label,
      rel: path.relative(src, file),
    };
  });

  // Group + order for display.
  const byGroup = {};
  for (const r of records) (byGroup[r.group] = byGroup[r.group] || []).push(r);
  const groups = Object.keys(byGroup).sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

  const generatedAt = new Date().toISOString();
  const empty = records.length === 0;

  const cards = groups.map((g) => {
    const items = byGroup[g].map((r) => `
      <figure class="shot">
        <figcaption>
          <span class="label">${esc(r.label)}</span>
          <code class="stem">${esc(r.stem)}</code>
          <span class="bytes">${(r.bytes / 1024).toFixed(1)} KiB</span>
        </figcaption>
        <a href="images/${esc(r.fname)}" target="_blank" rel="noreferrer">
          <img loading="lazy" src="images/${esc(r.fname)}" alt="${esc(r.label)}">
        </a>
      </figure>`).join('\n');
    return `<section class="group"><h2>${esc(g)}</h2>${items}</section>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cake-autorate LuCI — visual review gallery</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem;
         background: Canvas; color: CanvasText; }
  header { border-bottom: 1px solid rgba(128,128,128,.35); padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
  .meta { opacity: .7; font-size: .85rem; }
  .group { margin-bottom: 2.5rem; }
  .group h2 { font-size: 1.1rem; border-left: 4px solid #4caf50; padding-left: .5rem; }
  .shot { margin: 0 0 1.5rem; border: 1px solid rgba(128,128,128,.35);
          border-radius: .4rem; overflow: hidden; background: rgba(128,128,128,.06); }
  figcaption { display: flex; gap: .75rem; align-items: baseline; flex-wrap: wrap;
               padding: .5rem .75rem; background: rgba(128,128,128,.12); }
  figcaption .label { font-weight: 600; }
  figcaption .stem { opacity: .7; font-size: .8rem; }
  figcaption .bytes { margin-left: auto; opacity: .6; font-size: .8rem; }
  .shot img { display: block; width: 100%; height: auto; }
  .empty { padding: 2rem; border: 1px dashed rgba(128,128,128,.5); border-radius: .5rem; }
</style>
</head>
<body>
<header>
  <h1>cake-autorate LuCI — visual review gallery</h1>
  <p class="meta">
    ${records.length} full-page screenshot(s) · generated ${esc(generatedAt)}<br>
    Dynamic status cells (<code>[data-live="1"]</code>: rates, OWD deltas, load
    conditions, uptime, last-update datetime, run badge) are masked in these
    baselines, so churning numbers are hidden and only structure/styling shows.
    Click any image to open it full size.
  </p>
</header>
${empty
  ? '<div class="empty">No baseline screenshots found. Run <code>npx playwright test --project=visual --update-snapshots</code> first, then regenerate.</div>'
  : cards}
</body>
</html>
`;

  fs.writeFileSync(path.join(out, 'index.html'), html);

  // Manifest for CI and debugging to read.
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
    generatedAt, count: records.length,
    images: records.map((r) => ({ stem: r.stem, file: `images/${r.fname}`, group: r.group, label: r.label, bytes: r.bytes })),
  }, null, 2));

  console.log(`[gallery] ${records.length} image(s) -> ${path.join(out, 'index.html')}`);
  for (const r of records) console.log(`  - ${r.group} :: ${r.label}  (${r.fname})`);
  if (empty) console.log('[gallery] WARNING: no baselines found; gallery is a placeholder.');
}

main();
