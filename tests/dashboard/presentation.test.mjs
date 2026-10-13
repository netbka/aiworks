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
const view = (campaigns) => ownerView({ available: true, campaigns, coordinator: null, recent: null });
// Issue titles are not read from GitHub: campaigns that share a declared purpose are told apart by their ids.
const shared = { purpose: 'Design PR inventory reconciliation' };

test('campaign titles prefer declared wording; names built from ids are humanized, without issue numbers or a dash', () => {
  const v = view([
    campaign('dyk-455-telegram-ingest', [step('FIX-455', 'Telegram ingestion: analysed messages must not be sent again')]),
    campaign('dyk-442-pilot-whatsapp', [step('P-404', 'WhatsApp pairing code', 'WhatsApp pairing recovers an interrupted result')]),
    campaign('dyk-458-design-contracts', [step('A', 'a'), step('B', 'b')], shared),
    campaign('dyk-458-task-details', [step('A', 'a'), step('B', 'b')], shared),
    campaign('dyk-closeout-458-405', [step('A', 'a'), step('B', 'b')], shared),
    campaign('dyk-open-runtime-prs', [step('A', 'a'), step('B', 'b')], shared),
    campaign('declared', [step('A', 'a'), step('B', 'b')], { purpose: 'One accountable delivery' }),
    campaign('undeclared', [step('A', 'a'), step('B', 'b')]),
  ]);
  const titles = Object.fromEntries(Object.entries(v.campaigns).map(([id, c]) => [id, c.purpose]));
  assert.deepEqual(titles['dyk-455-telegram-ingest'], { text: 'Telegram ingestion: analysed messages must not be sent again', from: 'step-title' }, 'one step: what it delivers');
  assert.deepEqual(titles['dyk-442-pilot-whatsapp'], { text: 'WhatsApp pairing recovers an interrupted result', from: 'step-outcome' }, 'its declared outcome first');
  assert.deepEqual(titles.declared, { text: 'One accountable delivery', from: 'declaration' });
  assert.equal(titles.undeclared, null, 'several steps and no declared purpose: the page shows the campaign id; no issue title is fetched');
  assert.deepEqual(['dyk-458-design-contracts', 'dyk-458-task-details', 'dyk-closeout-458-405', 'dyk-open-runtime-prs'].map((id) => [titles[id].text, titles[id].variant]), [
    ['Design PR inventory reconciliation', 'Design contracts'], ['Design PR inventory reconciliation', 'Task details'],
    ['Design PR inventory reconciliation', 'Closeout'], ['Design PR inventory reconciliation', 'Open runtime PRs']]);
  // Numbers come back only when the names would otherwise be the same.
  const same = view([campaign('dyk-458-fix', [step('A', 'a'), step('B', 'b')], shared), campaign('dyk-459-fix', [step('A', 'a'), step('B', 'b')], shared)]);
  assert.deepEqual(Object.values(same.campaigns).map((c) => c.purpose.variant), ['458 fix', '459 fix']);
  assert.match(page('dashboard.js'), /purpose\?\.variant \? ` \(\$\{purpose\.variant\}\)` : ''/);
  assert.doesNotMatch(page('dashboard.js'), / — \$\{purpose\.variant\}/, 'no dash before the distinguishing name');
});

test('a new view starts at its top; Back and Forward return to where that view was left', () => {
  const js = page('dashboard.js');
  // Scroll is remembered per address; a new destination gets a history entry and opens at its top, Back and Forward restore.
  assert.match(js, /function go\(address, \{ restore = false \} = \{\}\) \{\r?\n  scrollMemory\.set\(current\.address, window\.scrollY\);\r?\n  const next = resolveRoute\(address\);\r?\n  if \(!restore\) history\.pushState\(null, '', next\.address\);\r?\n  else if \(next\.replace\) history\.replaceState\(null, '', next\.address\);\r?\n  current = next;\r?\n  showRoute\(\);\r?\n  window\.scrollTo\(0, restore \? scrollMemory\.get\(current\.address\) \?\? 0 : 0\);/);
  assert.match(js, /history\.scrollRestoration = 'manual'/, 'the browser does not fight the per-address scroll');
  // Every destination link opens through go(), unless the owner asked for a new tab or window.
  assert.match(js, /const anchor = event\.target\.closest\?\.\('a\[href\^="#\/"\]'\);\r?\n  if \(!anchor \|\| event\.defaultPrevented \|\| event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) return;\r?\n  event\.preventDefault\(\);\r?\n  if \(resolveRoute\(anchor\.getAttribute\('href'\)\)\.address !== current\.address\) go\(anchor\.getAttribute\('href'\)\);/);
  assert.match(js, /addEventListener\('hashchange', \(\) => \{ if \(location\.hash !== current\.address\) go\(location\.hash, \{ restore: true \}\); \}\)/);
  // In-page links to other screens are links to their addresses, so they also start at the top.
  for (const target of ['#/settings/diagnostics', '#/settings/messages', '#/projects']) assert.match(js, new RegExp(`routeLink\\('[^']+', '${target}'`), `in-page link to ${target}`);
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
  assert.deepEqual(v.items.map((item) => item.points[0]), [{ link: { label: 'AIWorks issue #2', url: SUPERVISOR_ISSUE },
    text: 'Not yours to fix: it is tracked for AIWorks’ maintainers. This work may not move until it is fixed.' }]);
  const js = page('dashboard.js');
  // The journal moved from Activity to Settings › Diagnostics; the link goes there.
  assert.match(js, /Not an owner action: these are supervisor faults for AIWorks's maintainers\. `,\r?\n    link\('Supervisor issue #2 ↗', 'https:\/\/github\.com\/netbka\/aiworks\/issues\/2'\), ' · ', routeLink\('When, in Diagnostics', '#\/settings\/diagnostics'\)\)/);
  assert.doesNotMatch(js, /for whoever maintains AIWorks, not an owner action/);
});

// Navigation shell (docs/design/OWNER_WORKSPACE.md slice S1): Projects, Needs me and Settings; project tabs; links for
// destinations; aria-current; focus and title on a route change; drafts per address; the §6.1 layout at 320px.

test('the global navigation is Projects, Needs me and Settings, as links; the skip link stays first', () => {
  const html = page('index.html');
  const nav = /<nav class="global-nav" aria-label="Main navigation">([\s\S]*?)<\/nav>/.exec(html)?.[1];
  assert.ok(nav, 'one global navigation');
  assert.deepEqual([...nav.matchAll(/<a href="(#\/[^"]+)" data-global="(\w+)" class="nav-item">[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m.slice(1)),
    [['#/projects', 'projects', 'Projects'], ['#/needs', 'needs', 'Needs me'], ['#/settings', 'settings', 'Settings']]);
  assert.doesNotMatch(nav, /<button/, 'destinations are links, not buttons');
  // Today's six technical views are gone from the navigation; their content moved (OWNER_WORKSPACE §9).
  assert.doesNotMatch(html, /data-view|Issues &amp; PRs|Issues & PRs|>\s*Agents\b|>\s*Activity\b|>\s*Overview\b/);
  // The header keeps a Messages link instead of a "Message coordinator" button, and the mark links to Projects.
  assert.match(html, /<a id="messages-link" class="messages-link" href="#\/settings\/messages">✉ Messages <span id="message-count" class="nav-count"><\/span><\/a>/);
  assert.match(html, /<a class="brand" href="#\/projects">/);
  assert.doesNotMatch(html, /open-message|Message coordinator/);
  assert.match(html, /<nav id="project-tabs" class="project-tabs" aria-label="Project" hidden><\/nav>/);
  assert.doesNotMatch(html, /role="tab/, 'project tabs are links with their own addresses, not an ARIA tablist');
  assert.match(html, /<body>\s*<a class="skip-link" href="#main">Skip to content<\/a>/, 'the skip link is the first thing in the page');
  // The skip link would otherwise change the address to an unknown one; it moves focus instead.
  assert.match(page('dashboard.js'), /\$\('\.skip-link'\)\.addEventListener\('click', \(event\) => \{ event\.preventDefault\(\); \$\('#main'\)\.focus\(\); \}\);/);
});

test('every destination in the page script is a link to its address; buttons only act', () => {
  const js = page('dashboard.js');
  assert.match(js, /^import \{ formatRoute, globalOf, resolveRoute, tabOf \} from '\/router\.mjs';$/m, 'addresses come from the one router module');
  assert.doesNotMatch(js, /button\([^)]*\(\) => go\(/, 'no button navigates');
  assert.doesNotMatch(js, /\bsetView\b|location\.hash = /, 'nothing writes the address except go() and the first redirect');
  assert.match(js, /const routeLink = \(text, route, cls = ''\) => el\('a', \{ href: typeof route === 'string' \? route : formatRoute\(route\), class: cls \}, text\);/);
  // Project tabs: four links built from the router, in order.
  assert.match(js, /const tabLabels = \{ now: 'Now', work: 'Work', results: 'Results', cost: 'Cost' \};/);
  assert.match(js, /el\('a', \{ href: formatRoute\(\{ screen: 'project', project, tab: id \}\),/);
  // An empty, legacy or unknown address is rewritten once, without a history entry.
  assert.match(js, /if \(current\.replace\) history\.replaceState\(null, '', current\.address\);\r?\nshowRoute\(\);/);
});

test('the current place has aria-current="page" in the global bar and the project tabs', () => {
  const js = page('dashboard.js');
  assert.match(js, /const place = globalOf\(route\);\r?\n  for \(const node of document\.querySelectorAll\('\[data-global\]'\)\) \{\r?\n    node\.classList\.toggle\('active', node\.dataset\.global === place\);\r?\n    if \(node\.dataset\.global === place\) node\.setAttribute\('aria-current', 'page'\); else node\.removeAttribute\('aria-current'\);/);
  assert.match(js, /class: `tab\$\{id === tab \? ' active' : ''\}`, 'aria-current': id === tab && route\.screen === 'project' \? 'page' : null \}/);
  assert.match(js, /if \(route\.screen === 'settings' && route\.section === 'messages'\) messages\.setAttribute\('aria-current', 'page'\); else messages\.removeAttribute\('aria-current'\);/);
  assert.match(js, /tabs\.hidden = !project;/, 'tabs show only inside a project');
});

test('a route change moves focus to the heading and names the screen, project and AIWorks in the title', () => {
  assert.match(page('index.html'), /<h1 id="view-title" tabindex="-1">Projects<\/h1>/);
  assert.match(page('index.html'), /<title>Projects · AIWorks<\/title>/);
  const js = page('dashboard.js');
  assert.match(js, /document\.title = \[title, project \? projectName\(project\) : null, 'AIWorks'\]\.filter\(Boolean\)\.join\(' · '\);/);
  assert.match(js, /showRoute\(\);\r?\n  window\.scrollTo\([^\n]+\r?\n  \/\/ [^\n]+\r?\n  \$\('#view-title'\)\.focus\(\{ preventScroll: true \}\);/);
  // The 5-second refresh never moves focus: render() only puts focus back on the element that had it.
  assert.doesNotMatch(/function render\(\) \{[\s\S]*?\n\}/.exec(js)[0], /view-title'\)\.focus/);
});

test('drafts are kept per address in sessionStorage and cleared only after an accepted receipt', () => {
  const js = page('dashboard.js');
  assert.match(js, /const DRAFTS_KEY = 'aiworks-dashboard:drafts';/);
  assert.match(js, /sessionStorage\.setItem\(DRAFTS_KEY, JSON\.stringify\(all\)\)/);
  assert.match(js, /get: \(address, key\) => readDrafts\(\)\[`\$\{address\} \$\{key\}`\] \?\? null,/);
  // Saved while typing, so a reload keeps them.
  assert.match(js, /for \(const selector of \['#instruction-task', '#instruction-role', '#instruction-text'\]\) \$\(selector\)\.addEventListener\('input', saveDraft\);/);
  assert.match(js, /\$\('#message-text'\)\.addEventListener\('input', \(\) => \{ messageDraft\.text = \$\('#message-text'\)\.value; \}\);/);
  // Cleared only right after the server accepted the message or the instruction.
  assert.match(js, /const result = await post\('\/api\/messages', \{ requestId, text \}\);\r?\n      messageDraft\.text = '';/);
  assert.match(js, /const result = await post\('\/api\/commands', payload\);[\s\S]{0,900}?\r?\n    if \(payload\.action === 'instruct' && draftAddress\) drafts\.delete\(draftAddress, `instruction:\$\{payload\.campaignId\}`\);\r?\n  \} catch/);
  assert.equal(js.match(/drafts\.delete\(/g).length, 2, 'the message draft setter and the accepted instruction are the only deletions');
  assert.equal(js.match(/messageDraft\.text = ''/g).length, 1);
  // The last opened project is offered first on Projects.
  assert.match(js, /`Continue with \$\{projectName\(last\)\} →`/);
});

/** Width media blocks of a stylesheet: [condition, [[selector, declarations], ...]]. */
function widthBlocks(css) {
  const blocks = [];
  for (const match of css.matchAll(/@media\(([^)]*width[^)]*)\)\{/g)) {
    let depth = 1, i = match.index + match[0].length;
    const start = i;
    while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    const body = css.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, '');
    blocks.push([match[1], [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]])]);
  }
  return blocks;
}

test('the layout follows OWNER_WORKSPACE §6.1, and no action exists at only one width', () => {
  const css = page('dashboard.css'), blocks = widthBlocks(css);
  const conditions = blocks.map(([condition]) => condition);
  assert.ok(conditions.includes('max-width:959px') && conditions.includes('max-width:599px'), 'the 600px and 960px breakpoints');
  assert.ok(!conditions.includes('max-width:850px') && !conditions.includes('max-width:520px'), "today's 520px and 850px breakpoints are replaced");
  // Below 960px: a labelled bottom bar with the three destinations; the project tabs share the width at 320px.
  const rules = (condition) => blocks.find(([c]) => c === condition)[1];
  const narrow = rules('max-width:959px'), phone = rules('max-width:599px');
  assert.ok(narrow.some(([s, d]) => s === 'nav' && /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(d)));
  assert.ok(narrow.some(([s, d]) => s === '.sidebar' && /inset:auto 0 0 0/.test(d)), 'the bar sits at the bottom');
  assert.ok(narrow.some(([s, d]) => s === '.nav-item' && /font-size:11px/.test(d)), 'each destination keeps its label');
  assert.ok(phone.some(([s, d]) => s === '.tab' && /flex:1 1 0/.test(d)), 'four tabs fit without scrolling');
  // Touch targets are at least 44 by 44 CSS px.
  for (const selector of ['.nav-item', '.tab', '.messages-link', '.brand', '.continue-link']) {
    const declaration = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\{[^}]*min-height:(\\d+)px`).exec(css);
    assert.ok(declaration && Number(declaration[1]) >= 44, `${selector} is at least 44px high`);
  }
  // Nothing exists at only one width: no width rule hides a link, a button, a destination or a control.
  const action = /(?:^|[\s>+~])(?:a|button|nav|select|input|summary)(?=$|[\s.:#[>+~])|\.(?:nav-item|global-nav|button|brand|tab|project-tabs|messages-link|topbar-actions|continue-link|project-name|skip-link|campaign-controls|filters|table-actions|c-action|needs-link)\b/;
  const hidden = blocks.flatMap(([condition, list]) => list.filter(([, d]) => /display:none|visibility:hidden/.test(d))
    .flatMap(([selectors]) => selectors.split(',').map((s) => s.trim()).filter((s) => action.test(s)).map((s) => `${condition}: ${s}`)));
  assert.deepEqual(hidden, []);
  // No sideways scroll at 320px: a phone-width rule never sets a fixed page-level width.
  for (const [selector, declarations] of [...narrow, ...phone]) {
    if (/table/.test(selector)) continue; // wide tables scroll inside their own container (.table-scroll{overflow:auto})
    assert.doesNotMatch(declarations, /(?:^|;)(?:min-)?width:(?:[4-9]\d\d|\d{4,})px/, selector);
  }
  assert.match(css, /\.table-scroll\{overflow:auto\}/);
});
