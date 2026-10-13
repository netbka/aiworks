// Owner words only (aiworks#11, UX-002 review of the owner dashboard at 96ed590, findings F3, F7, F14, F18, F22, F23 and
// F24): the page as the owner sees it, built by the unchanged dashboard.js on the review fixture through the real
// dashboard server (tests/dashboard/fixtures/page.mjs). No internal word outside a details disclosure; refusals say what
// happened and what to do; "this computer" for the computer the dashboard runs on; one time per event; counts that
// match the breakdown; no machine words in the footer. Settings › Diagnostics is left out on purpose: it is where the
// machine's own words belong (OWNER_WORKSPACE §2.2). Disposable stores, local git and a loopback server only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { openPage, visibleText, internalWords } from './fixtures/page.mjs';
import { PROJECTS } from './fixtures/review-store.mjs';

const address = (project, tail = '') => `#/p/${encodeURIComponent(project)}${tail}`;
const PROJECT_TABS = ['', '/work', '/results', '/cost', '/start'];
// The page's own formats: "13 Oct 01:24" for a date and time, "02:24" for a time.
const dateTime = (value) => new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');
const time = (value) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const nodes = (page, tag) => [...page.document.body.walk()].filter((node) => node.tagName === tag);
const buttonNamed = (page, text, within = page.document.body) => [...within.walk()].find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === text);
/** The work panel on Work whose heading names `title`. */
const workPanel = (page, title) => page.$('#content').querySelectorAll('section.panel').find((node) => node.querySelector('h2')?.textContent.includes(title));
const screen = (page) => visibleText(page.$('#main'));

test('every owner screen of the review fixture is in owner words, outside a details disclosure', async (t) => {
  const findings = [];
  const check = (where, text) => { for (const found of internalWords(text)) findings.push(`${where}: ${found}`); };
  // The first run and records that cannot be read: the global screens.
  for (const store of ['empty', 'unreadable']) {
    const page = await openPage(t, { store });
    for (const where of ['#/projects', '#/needs', '#/settings', '#/settings/messages', '#/projects/add']) { await page.go(where); check(`${store} ${where}`, page.text()); }
  }
  // Every state of the full store: the global screens, each project's tabs and Start work, and every step.
  const page = await openPage(t);
  const screens = ['#/projects', '#/needs', '#/settings', '#/settings/messages', '#/projects/add'];
  for (const project of PROJECTS) for (const tab of PROJECT_TABS) screens.push(address(project, tab));
  for (const c of supervisorSnapshot(page.dataDir).campaigns) for (const task of c.tasks) screens.push(address(c.repository, `/step/${c.id}/${task.id}`));
  assert.ok(screens.length > 40, `${screens.length} screens`);
  for (const where of screens) {
    await page.go(where);
    assert.ok(page.$('#content').childNodes.length, `${where} draws something`);
    check(where, page.text());
  }
  // The dialogs the owner opens from those screens: guidance for a step, and Cancel.
  await page.go(address('example/shop-app', '/step/shop-checkout/T2'));
  buttonNamed(page, 'Send guidance').click();
  assert.equal(page.$('#instruction-dialog').open, true);
  check('guidance dialog', visibleText(page.$('#instruction-dialog')));
  page.$('#instruction-dialog').close();
  await page.go(address('example/shop-app', '/work'));
  buttonNamed(page, 'Cancel work…', workPanel(page, 'Let customers pay at checkout')).click();
  assert.equal(page.$('#cancel-dialog').open, true);
  check('cancel dialog', visibleText(page.$('#cancel-dialog')));
  page.$('#cancel-dialog').close();
  // What the page says after a command: Check again, Pause, and a Resume that is refused.
  buttonNamed(page, 'Check again', workPanel(page, 'Let customers save a wishlist')).click();
  await page.settle();
  check('Check again notice', page.text());
  await page.go(address('example/recipes', '/work'));
  buttonNamed(page, 'Resume', workPanel(page, 'Import recipes')).click();
  await page.settle();
  check('Resume refused notice', page.text());
  await page.go(address('example/recipes', '/work'));
  buttonNamed(page, 'Pause', workPanel(page, 'Add cooking timers')).click();
  await page.settle();
  check('Pause notice', page.text());
  assert.deepEqual(findings, []);
});

test('F3: a refused Resume says what happened, that nothing changed and what to do; the rule and files are in Details', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/recipes', '/work'));
  buttonNamed(page, 'Resume', workPanel(page, 'Import recipes')).click();
  await page.settle();
  const notice = page.$('#notice'), said = visibleText(notice);
  assert.equal(notice.hidden, false);
  assert.equal(said, 'AIWorks did not resume this work. Nothing changed: it is still paused. It resumes only work whose plan is merged into AIWorks, and this work’s plan is not. Merge its plan into AIWorks, then press Resume again. Details');
  assert.deepEqual(internalWords(said), []);
  assert.doesNotMatch(said, /cli\.mjs|campaigns\/|AW-005|declaration/);
  // The machine's reason is one click away, unchanged.
  const [details] = notice.querySelectorAll('details');
  assert.equal(details.querySelector('summary').textContent, 'Details');
  assert.match(details.textContent, /Resume refused: .*campaigns\//);
  // Nothing changed: the work is still paused.
  assert.equal(supervisorSnapshot(page.dataDir).campaigns.find((c) => c.id === 'recipes-import').control, 'paused');
});

test('F7: Needs me, Work, Step and notices use owner words: no stop class, step ID, "executor", "campaign", "controller" or "Checker accepted"', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/notes-site', '/work'));
  const notes = screen(page);
  assert.match(notes, /notes-site: Publish the site preview Stopped: No AI worker on this computer can do this step /);
  assert.doesNotMatch(notes, /Stopped \(B2\)|executor/);
  await page.go(address('example/shop-app', '/work'));
  const shop = screen(page);
  assert.match(shop, /shop-app: Let customers pay at checkout Being built: Checkout form /);
  assert.match(shop, /shop-app: Show product reviews Being checked: Product review list /);
  assert.doesNotMatch(shop, /Building T\d|checking T\d/i);
  await page.go('#/needs');
  const needs = screen(page);
  assert.match(needs, /Contracts import Open PR #104 ↗ Passed the check at [0-9a-f]{7} · CI and conflicts on the PR “Price sync” cannot start until you merge it\./);
  assert.doesNotMatch(needs, /Checker accepted|Open step issue \(T\d\)|\bT\d cannot start|owner-reserved|· campaign /);
  assert.equal(nodes(page, 'A').filter((node) => node.textContent === 'Open the step issue ↗').length, 3, 'the step issue links, named without an ID');
  assert.match(needs, /This work is stopped What AIWorks recorded Tracking issue ↗ No AI worker on this computer can do this step\. What to do: /);
  // The stop class and the supervisor's own reason stay in that disclosure.
  const recorded = nodes(page, 'DETAILS').find((node) => node.querySelector('summary').textContent === 'What AIWorks recorded');
  assert.match(recorded.textContent, /B2 · No configured executor supports this task role/);
  // Check again: the notice names no machine part.
  await page.go(address('example/shop-app', '/work'));
  buttonNamed(page, 'Check again', workPanel(page, 'Let customers save a wishlist')).click();
  await page.settle();
  assert.equal(visibleText(page.$('#notice')), 'Check again requested. AIWorks looks at this work again; its limits and the independent check still apply.');
});

test('F14: the Cost summary counts the pieces of work its runs are in, as the breakdown shows them', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/shop-app', '/cost'));
  const pieces = page.$('#content').querySelectorAll('section.panel').filter((node) => node.dataset.focusScope?.startsWith('cost/'));
  const runs = pieces.map((node) => Number(/^(\d+) runs?/.exec(node.querySelector('p').textContent)[1]));
  const ran = runs.filter((n) => n > 0).length, total = runs.reduce((n, value) => n + value, 0);
  assert.deepEqual([pieces.length, ran, total], [5, 1, 6], 'shop-app: five pieces of work, one of them with all six runs');
  assert.ok(screen(page).includes(' 6 runs in 1 of 5 pieces of work. '), screen(page));
  assert.doesNotMatch(screen(page), /6 runs in 5 pieces of work/);
});

test('F18: the empty state names the configuration file on this computer, never "settings", which is the Settings screen', async (t) => {
  const page = await openPage(t, { store: 'empty' });
  await page.go('#/projects');
  assert.match(screen(page), /No projects yet\. Projects appear here when the AIWorks configuration file on this computer lists a repository\. Adding a project from this page is not built yet\./);
  // One name for the file wherever it is mentioned; "Settings" is only the screen.
  for (const where of ['#/projects', '#/settings', '#/projects/add']) {
    await page.go(where);
    assert.doesNotMatch(screen(page), /AIWorks settings|AIWorks’ settings|computer’s settings/, where);
  }
  await page.go('#/settings');
  assert.match(screen(page), /Codex · not set up on this computer The AIWorks configuration file on this computer sets no command for it/);
});

test('F22: AIWorks stopped "on this computer", with the restart on this computer, never "there" or "that computer"', async (t) => {
  const page = await openPage(t, { host: 'review-pc' });
  const restart = 'If nobody is updating it right now, restart it on this computer: sign out and sign in again, or start the task “AIWorks Supervisor”.';
  for (const where of ['#/needs', address('example/notes-site'), address('example/notes-site', '/work')]) {
    await page.go(where);
    const text = screen(page);
    assert.doesNotMatch(text, /\bthere\b|that computer|on review-pc|on its computer/, where);
    // notes-site's Now leads with its own Needs me items (review F16); AIWorks stopped is said once, on Needs me (F9).
    if (where === '#/needs') assert.ok(text.includes(restart), `${where} says where to restart`);
  }
  await page.go('#/needs');
  assert.ok(screen(page).includes('AIWorks stopped on this computer at about '));
  // The computer's name is in the header, next to "this computer".
  assert.equal(page.$('#host-name').textContent, 'review-pc · this computer');
});

test('F23: one time for one event: the pause has its date, the stop its time, the same on Now, Work and Needs me', async (t) => {
  const page = await openPage(t);
  const tags = supervisorSnapshot(page.dataDir).campaigns.find((c) => c.id === 'notes-tags');
  const paused = dateTime(tags.pausedAt), stopped = time(Date.parse(tags.leaseExpiresAt));
  assert.notEqual(time(tags.pausedAt), stopped, 'the fixture paused it an hour before AIWorks stopped');
  // notes-site's Now leads with its Needs me items (review F16), so the stop is said on Work and Needs me.
  await page.go(address('example/notes-site'));
  const now = screen(page);
  await page.go(address('example/notes-site', '/work'));
  const work = screen(page);
  assert.ok(work.includes(`notes-site: Tag notes Paused since ${paused} · `), work);
  assert.ok(work.includes(`· AIWorks stopped on this computer at about ${stopped} Resume`), work);
  await page.go('#/needs');
  const needs = screen(page);
  // One item for the stop (review F9): its time once, and the pause named on the work it holds up.
  assert.ok(needs.includes(`AIWorks stopped on this computer at about ${stopped} `), needs);
  assert.ok(needs.includes('“Tag notes” (paused; it can’t resume until AIWorks runs again)'), needs);
  for (const text of [now, work, needs]) {
    // The stop's time never reads as the pause's: every "at about <time>" follows "stopped on this computer".
    assert.doesNotMatch(text, /paused at about|last check-in about/i);
    const times = text.split(`at about ${stopped}`).length - 1;
    assert.equal(text.split(`stopped on this computer at about ${stopped}`).length - 1, times, text);
  }
});

test('F24: the footer of every screen says only when the page last checked, without machine words', async (t) => {
  const page = await openPage(t);
  for (const where of ['#/projects', '#/needs', '#/settings', address('example/shop-app'), address('example/shop-app', '/cost')]) {
    await page.go(where);
    const footer = visibleText(page.$('footer'));
    assert.match(footer, /^review-pc · Checked \d\d:\d\d · merges (checked .+|not checked yet)$/, where);
    assert.doesNotMatch(footer, /supervisor|execution state|GitHub API/i, where);
  }
  // How merges are read is still said, where the machine is described.
  await page.go('#/settings/diagnostics');
  assert.match(screen(page), /No GitHub API call is made/);
});
