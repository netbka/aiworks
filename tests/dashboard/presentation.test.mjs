// Presentation follow-ups from the live reviews of the owner view (engineering-platform-archive#78): readable campaign titles, view navigation
// that starts at the top, provider detail only where it matters, a neutral host placeholder, an explicit page
// background, large-screen scaling and actionable supervisor-fault wording. Synthetic owner-view input only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownerView, SUPERVISOR_ISSUE } from '../../src/dashboard/owner.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const page = (file) => readFileSync(join(ROOT, 'src/dashboard/public', file), 'utf8');
const campaign = (id, tasks = [], extra = {}) => ({ id, repository: 'netbka/Dyk', trackingIssue: 458, trackingUrl: 'https://github.com/netbka/Dyk/issues/458', purpose: null,
  control: 'finished', readiness: 'COMPLETE', controllerLive: false, livenessDefect: false, leaseExpiresAt: null, blocker: null, tasks, agents: [], lastProgressAt: null, ...extra });
const step = (id, title, outcome = null) => ({ id, title, outcome, state: 'pending', resultUrl: null, dependsOn: [], attempts: 0, verifierRejections: 0, verifiedSha: null });
const view = (campaigns) => ownerView({ available: true, campaigns, coordinator: null, recent: null },
  [{ repository: 'netbka/Dyk', fetchedAt: new Date().toISOString(), error: null, items: [{ kind: 'issue', number: 458, title: 'P-458: Design PR inventory reconciliation' }] }]);

test('campaign titles prefer declared wording; names built from ids are humanized, without issue numbers or a dash', () => {
  const v = view([
    campaign('dyk-455-telegram-ingest', [step('FIX-455', 'Telegram ingestion: analysed messages must not be sent again')]),
    campaign('dyk-442-pilot-whatsapp', [step('P-404', 'WhatsApp pairing code', 'WhatsApp pairing recovers an interrupted result')]),
    campaign('dyk-458-design-contracts', [step('A', 'a'), step('B', 'b')]),
    campaign('dyk-458-task-details', [step('A', 'a'), step('B', 'b')]),
    campaign('dyk-closeout-458-405', [step('A', 'a'), step('B', 'b')]),
    campaign('dyk-open-runtime-prs', [step('A', 'a'), step('B', 'b')]),
    campaign('declared', [step('A', 'a'), step('B', 'b')], { purpose: 'One accountable delivery' }),
  ]);
  const titles = Object.fromEntries(Object.entries(v.campaigns).map(([id, c]) => [id, c.purpose]));
  assert.deepEqual(titles['dyk-455-telegram-ingest'], { text: 'Telegram ingestion: analysed messages must not be sent again', from: 'step-title' }, 'one step: what it delivers');
  assert.deepEqual(titles['dyk-442-pilot-whatsapp'], { text: 'WhatsApp pairing recovers an interrupted result', from: 'step-outcome' }, 'its declared outcome first');
  assert.deepEqual(titles.declared, { text: 'One accountable delivery', from: 'declaration' });
  assert.deepEqual(['dyk-458-design-contracts', 'dyk-458-task-details', 'dyk-closeout-458-405', 'dyk-open-runtime-prs'].map((id) => [titles[id].text, titles[id].variant]), [
    ['Design PR inventory reconciliation', 'Design contracts'], ['Design PR inventory reconciliation', 'Task details'],
    ['Design PR inventory reconciliation', 'Closeout'], ['Design PR inventory reconciliation', 'Open runtime PRs']]);
  // Numbers come back only when the names would otherwise be the same.
  const same = view([campaign('dyk-458-fix', [step('A', 'a'), step('B', 'b')]), campaign('dyk-459-fix', [step('A', 'a'), step('B', 'b')])]);
  assert.deepEqual(Object.values(same.campaigns).map((c) => c.purpose.variant), ['458 fix', '459 fix']);
  assert.match(page('dashboard.js'), /purpose\?\.variant \? ` \(\$\{purpose\.variant\}\)` : ''/);
  assert.doesNotMatch(page('dashboard.js'), / — \$\{purpose\.variant\}/, 'no dash before the distinguishing name');
});

test('a new view starts at its top; Back and Forward return to where that view was left', () => {
  const js = page('dashboard.js');
  assert.match(js, /function go\(next, \{ restore = false \} = \{\}\) \{\r?\n  scrollMemory\.set\(view, window\.scrollY\);\r?\n  setView\(next\);\r?\n  window\.scrollTo\(0, restore \? scrollMemory\.get\(view\) \?\? 0 : 0\);/);
  assert.match(js, /node\.addEventListener\('click', \(\) => \{ if \(node\.dataset\.view !== view\) go\(node\.dataset\.view\); \}\)/);
  assert.match(js, /addEventListener\('hashchange', \(\) => \{ if \(location\.hash\.slice\(1\) !== view\) go\(location\.hash\.slice\(1\), \{ restore: true \}\); \}\)/);
  for (const target of ['roadmap', 'agents', 'activity']) assert.match(js, new RegExp(`\\(\\) => go\\('${target}'\\)`), `in-page link to ${target} starts at the top`);
});

test('provider detail is shown for active campaigns only, and the provider note only when such a card exists', () => {
  const js = page('dashboard.js');
  assert.match(js, /if \(expanded\) card\.append\(\.\.\.\(terminal \? \[\] : \[providerStatus\(c\)\]\)/);
  assert.match(js, /cards\.some\(\(c\) => !\['finished', 'cancelled'\]\.includes\(c\.control\)\) \? providerNote\(\) : null/);
});

test('the sidebar shows a neutral placeholder until the host is known, never "This computer"', () => {
  const html = page('index.html');
  assert.match(html, /<strong id="host-name" aria-busy="true">…<\/strong><small id="host-detail">&nbsp;<\/small>/);
  assert.doesNotMatch(html, /This computer|Local dashboard/);
  assert.match(page('dashboard.js'), /\$\('#host-name'\)\.removeAttribute\('aria-busy'\)/);
});

test('the page background is explicit under a dark preference, and large screens get larger text and a wider column', () => {
  const css = page('dashboard.css');
  assert.match(css, /^body\{margin:0;font-size:14px;background:var\(--page\);color:#1d2839\}/m);
  assert.match(css, /@media\(prefers-color-scheme:dark\)\{:root,body\{background:var\(--page\);color:#1d2839\}\}/);
  assert.match(css, /color-scheme:light;--page:#f6f8fb/);
  assert.match(css, /@media\(min-width:1900px\)\{body\{zoom:1\.12\}\}/);
  assert.match(css, /@media\(min-width:2300px\)\{body\{zoom:1\.25\}main\{max-width:1700px\}\}/);
});

test('supervisor faults say they are not an owner action and point to where they are tracked', () => {
  const v = view([campaign('owner-intervention-core', [step('CORE-13', 'Owner-intervention core')], { control: 'registered', readiness: 'ACTIVE', controllerLive: true, livenessDefect: true })]);
  assert.deepEqual(v.items.map((item) => item.points[0]), [{ link: { label: 'Supervisor issue #2', url: SUPERVISOR_ISSUE },
    text: 'Not an owner action: this is a supervisor fault for AIWorks\'s maintainers. Work in this campaign may not progress until it is fixed.' }]);
  const js = page('dashboard.js');
  assert.match(js, /Not an owner action: these are supervisor faults for AIWorks's maintainers\. `,\r?\n    link\('Supervisor issue #2 ↗', 'https:\/\/github\.com\/netbka\/aiworks\/issues\/2'\), ' · ', button\('When, in Activity', \(\) => go\('activity'\), 'link small'\)\)/);
  assert.doesNotMatch(js, /for whoever maintains AIWorks, not an owner action/);
});
