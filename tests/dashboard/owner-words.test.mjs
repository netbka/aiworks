// Owner words only (aiworks#11, UX-002 review of the owner dashboard at 96ed590, findings F3, F7, F14, F18, F22, F23 and
// F24): the page as the owner sees it, built by the unchanged dashboard.js on the review fixture through the real
// dashboard server (tests/dashboard/fixtures/page.mjs). No internal word outside a details disclosure; refusals say what
// happened and what to do; "this computer" for the computer the dashboard runs on; one time per event; counts that
// match the breakdown; no machine words in the footer. Settings › Diagnostics is left out on purpose: it is where the
// machine's own words belong (OWNER_WORKSPACE §2.2). Disposable stores, local git and a loopback server only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { resultMeaning } from '../../src/dashboard/copy.mjs';
import { LOCAL_START, projectMessage, UNREGISTERED } from '../../src/dashboard/projects.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { LANE } from '../../src/supervisor/coordinator.mjs';
import { Store } from '../../src/supervisor/store.mjs';
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
    for (const where of ['#/projects', '#/needs', '#/settings', '#/settings/messages', '#/settings/instructions', '#/projects/add']) { await page.go(where); check(`${store} ${where}`, page.text()); }
  }
  // Every state of the full store: the global screens, each project's tabs and Start work, and every step.
  const page = await openPage(t);
  const screens = ['#/projects', '#/needs', '#/settings', '#/settings/accounts', '#/settings/messages', '#/settings/instructions', '#/projects/add'];
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
  assert.equal(said, 'AIWorks did not resume this work. Nothing changed: it is still paused. The AIWorks software here is not merged yet. Update AIWorks to a reviewed version, then press Resume again. Details');
  assert.deepEqual(internalWords(said), []);
  assert.doesNotMatch(said, /cli\.mjs|campaigns\/|AW-005|declaration/);
  // The machine's reason is one click away, unchanged.
  const [details] = notice.querySelectorAll('details');
  assert.equal(details.querySelector('summary').textContent, 'Details');
  assert.match(details.textContent, /Resume refused: .*not merged/);
  // Nothing changed: the work is still paused.
  assert.equal(supervisorSnapshot(page.dataDir).campaigns.find((c) => c.id === 'recipes-import').control, 'paused');
});

test('F7: Needs me, Work, Step and notices use owner words: no stop class, step ID, "executor", "campaign", "controller" or "Checker accepted"', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/notes-site', '/work'));
  const notes = screen(page);
  // Inside a project's own Work screen the work is not prefixed with the project's name again.
  assert.match(notes, /Publish the site preview Stopped: No AI worker on this computer can do this step /);
  assert.doesNotMatch(notes, /notes-site: Publish the site preview/);
  assert.doesNotMatch(notes, /Stopped \(B2\)|executor/);
  await page.go(address('example/shop-app', '/work'));
  const shop = screen(page);
  assert.match(shop, /Let customers pay at checkout Being built: Checkout form /);
  assert.match(shop, /Show product reviews Being checked: Product review list /);
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
  assert.deepEqual([pieces.length, ran, total], [5, 4, 11], 'shop-app: five pieces of work, four of them with the eleven runs');
  assert.ok(screen(page).includes(' 11 runs in 4 of 5 pieces of work. '), screen(page));
  assert.doesNotMatch(screen(page), /11 runs in 5 pieces of work/);
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
  // AIWorks itself stopped is the stopped store (review 4 F2: in the full store it runs).
  const page = await openPage(t, { host: 'review-pc', store: 'stopped' });
  const restart = 'If nobody is updating it right now, sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in. If AIWorks still does not start, whoever set up AIWorks on this computer needs to look at it.';
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
  const page = await openPage(t, { store: 'stopped' });
  const tags = supervisorSnapshot(page.dataDir).campaigns.find((c) => c.id === 'notes-tags');
  const paused = dateTime(tags.pausedAt), stopped = time(Date.parse(tags.leaseExpiresAt));
  assert.notEqual(time(tags.pausedAt), stopped, 'the fixture paused it an hour before AIWorks stopped');
  // notes-site's Now leads with its Needs me items (review F16), so the stop is said on Work and Needs me.
  await page.go(address('example/notes-site'));
  const now = screen(page);
  await page.go(address('example/notes-site', '/work'));
  const work = screen(page);
  assert.ok(work.includes(`Tag notes Paused since ${paused} · `), work);
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
    // How fresh the merge check is belongs on the row that uses it, not in the footer (aiworks#11 review F8).
    assert.match(footer, /^review-pc · Checked \d\d:\d\d$/, where);
    assert.doesNotMatch(footer, /supervisor|execution state|GitHub API/i, where);
  }
  // How merges are read is still said, where the machine is described.
  await page.go('#/settings/diagnostics');
  assert.match(screen(page), /No GitHub API call is made/);
});

// aiworks#11 review 4 F4, F12, F13 and F17: what the report quoted, word for word, and the screens it quoted them on.
const F4_QUOTED = [
  "AIWorks can't read the project rules from governance provider. Set up the rules folder in Settings.",
  'The full activity journal, every step with its issue and pull request, the governance provider roadmap and how fresh each merge check is.',
  'Message #5 received: The supervisor stored it.',
  'Waiting · the coordinator agent picks it up within seconds',
  'Agents working 3 · 2 working normally · 1 possibly stuck or not started',
];
// The page's receipt times: "12:31" today, "13 Oct 12:31" on another day.
const TIME = /(?:\d{1,2} \w{3} )?\d\d:\d\d/.source;

test('F4 and F17: the guard catches each word the report quoted, and none is left on Add project, Settings, Start work or Messages', async (t) => {
  for (const text of F4_QUOTED) assert.ok(internalWords(text).length, `the guard catches: ${text}`);
  for (const word of ['governance provider', 'rules folder', 'supervisor', 'coordinator', 'Agents']) {
    assert.ok(F4_QUOTED.some((text) => internalWords(text).some((found) => found.startsWith(`${word} in`))), word);
  }
  // Add project: a GitHub project the project rules do not list, and every project-rules stop, say "your project rules".
  const codes = ['REGISTRY_MISSING', 'REGISTRY_AMBIGUOUS', 'REGISTRY_INVALID', 'GITHUB_REGISTERED', 'GOVERNANCE_ROOT_MISSING'];
  for (const text of [UNREGISTERED, LOCAL_START[0], ...codes.map((code) => projectMessage(code, { repository: 'example-org/sampleapp', ids: ['a', 'b'] }))]) {
    assert.deepEqual(internalWords(text), [], text);
  }
  assert.match(projectMessage('REGISTRY_MISSING', { repository: 'example-org/sampleapp' }), /^example-org\/sampleapp isn't listed in your project rules, /);
  assert.equal(projectMessage('REGISTRY_AMBIGUOUS', { repository: 'example-org/sampleapp', ids: ['a', 'b'] }),
    "Your project rules list example-org/sampleapp more than once (a, b). AIWorks won't guess which rules apply.");
  const page = await openPage(t);
  // Settings › More: what Diagnostics holds, in owner words; the platform's own name stays inside Diagnostics.
  await page.go('#/settings');
  assert.ok(screen(page).includes('Diagnostics The full activity journal, every step with its issue and pull request, the roadmap of the platform that keeps your project rules, and how fresh each merge check is.'), screen(page));
  // Messages: the heading, the line under it and every receipt.
  await page.go('#/settings/messages');
  const messages = screen(page);
  assert.match(messages, /Your messages to AIWorks AIWorks reads them and changes nothing · replies stay in this dashboard · /);
  assert.match(messages, new RegExp(`✓ Sent · AIWorks received your request at ${TIME} ✓ Read · AIWorks \\(Claude\\) started on it at ${TIME}`));
  assert.deepEqual(internalWords(messages), []);
  // F17: one word for AI workers on the Work metric.
  await page.go(address('example/shop-app', '/work'));
  assert.match(screen(page), /AI workers working ◎ 3 2 working normally · 1 possibly stuck or not started/);
  assert.doesNotMatch(screen(page), /Agents working/);
});

test('F4 and F12: the Start work receipt reads like §5.4 and promises no time unless AIWorks is known to read requests', async (t) => {
  const page = await openPage(t);
  const ask = async (goal) => {
    await page.go(address('example/shop-app', '/start'));
    const box = page.$('#start-goal');
    box.value = goal;
    box.dispatchEvent({ type: 'input', target: null, preventDefault() {} });
    page.$('form[data-start-form]').dispatchEvent({ type: 'submit', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    await page.settle();
    return { notice: visibleText(page.$('#notice')), receipt: screen(page) };
  };
  // The review store: AIWorks' work leases are live, but nothing reads requests (no request reader holds a lease).
  const first = await ask('Customers can pay with a saved card');
  // The notice, or the announcement of the new receipt that follows it on the next refresh: the same §5.4 words.
  assert.match(first.notice, new RegExp(`^(?:Sent ·|Message #\\d+ sent:) AIWorks received your request at ${TIME}\\.`), first.notice);
  assert.match(first.receipt, new RegExp(`✓ Sent · AIWorks received your request at ${TIME} … Waiting · AIWorks reads it when it next runs on this computer; this page can’t tell when that will be`), first.receipt);
  for (const text of [first.notice, first.receipt]) {
    assert.deepEqual(internalWords(text), [], text);
    assert.doesNotMatch(text, /within (seconds|a minute)|picks it up/, 'no pickup time while nothing is known to read requests');
  }
  // A request reader with a live lease: then, and only then, the receipt says when a request is usually picked up.
  const store = new Store(join(page.dataDir, 'supervisor.db'));
  store.insert('leases', { campaign_id: LANE, instance_id: 'owner-words-test', generation: 1, code_revision: 'review0fixture', acquired_at: Date.now(), expires_at: Date.now() + 60 * 60_000 });
  store.close();
  const second = await ask('Customers can save a card');
  assert.match(second.receipt, /… Waiting · AIWorks is running on this computer and usually starts on a request within a minute/, second.receipt);
});

test('F13: a step stopped on invalid results says in place what that failure is and what fixing it involves, without worker text', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/notes-site', '/step/notes-search/T1'));
  const step = screen(page);
  assert.ok(step.includes('Stopped: 5 attempts failed. Notes search. It will not retry by itself. Fix the cause, then check it again.'), step);
  assert.ok(step.includes('Last result: Builder (Claude): invalid result'), step);
  const said = resultMeaning({ outcome: 'invalid-result', role: 'Implementer' }, { stopped: true });
  const meaning = visibleText(page.$('[data-result-meaning]'));
  assert.equal(meaning, `${said.kind} ${said.fix}`);
  assert.match(meaning, /^Invalid result: the builder finished, but what it handed back failed AIWorks’ own checks, /);
  // Review 5 G4: what "the plan" is, where it is kept and who changes it; the fix is outside this page, and says so.
  assert.match(meaning, /Fixing the cause is done outside this page\. What each step must deliver, and which AI workers may do it, are set in the plan approved for this work\./);
  assert.match(meaning, /That plan is a file kept on this computer, and this page can’t change it\. Whoever set up AIWorks on this computer changes it: /);
  assert.doesNotMatch(meaning, /the plan on this computer/);
  // Review 5 G8: the Check again it names is on this screen.
  assert.match(meaning, /When the cause is fixed, choose Check again\.$/);
  assert.ok(buttonNamed(page, 'Check again', page.$('#content')), 'the Check again the sentence names is on the Step screen');
  assert.doesNotMatch(resultMeaning({ outcome: 'invalid-result', role: 'Implementer' }, { stopped: true, check: false }).fix, /Check again/,
    'where the screen has no Check again, the sentence does not name it');
  // In place: right after the last result, outside any Details disclosure, in owner words.
  assert.ok(step.indexOf('Last result: Builder (Claude): invalid result') < step.indexOf(meaning), step);
  assert.equal(page.$('[data-result-meaning]').closest('details'), null);
  assert.deepEqual(internalWords(meaning), []);
  // From the result's class and role only, never the worker's own text; a step that still retries is told so.
  assert.equal(resultMeaning({ outcome: 'invalid-result', role: 'Verifier', detail: 'worker text' }).fix, 'AIWorks tries again by itself. Nothing for you to do yet.');
  assert.match(resultMeaning({ outcome: 'invalid-result', role: 'Verifier' }).kind, /^Invalid result: the independent checker finished, /);
  for (const outcome of [null, { outcome: 'result', terminal: 'rejected' }, { outcome: 'timeout' }]) assert.equal(resultMeaning(outcome), null);
});

// Verifier finding B1 on UIF10: the review fixture's recent summary has merges only, so the every-screen guard never drew
// the home summary's failed runs, AIWorks' own problems or an inbox AIWorks cannot read. These states, drawn here.
test('F4 and F17: the Projects home, Needs me and Messages say AI worker and AIWorks when runs fail, AIWorks has problems or cannot read messages', async (t) => {
  const page = await openPage(t);
  const store = new Store(join(page.dataDir, 'supervisor.db'));
  const at = Date.now() - 60 * 60_000, reason = 'invalid coordinator configuration: unknown coordinator keys: agentModel';
  store.journal('shop-checkout', 'published', { task: 'T1' }, at);
  store.journal('shop-checkout', 'operation-finished', { task: 'T1', class: 'failure' }, at);
  store.journal('shop-checkout', 'operation-finished', { task: 'T1', class: 'result', terminal: 'rejected' }, at);
  store.journal('shop-checkout', 'step-error', { message: 'supervisor step failed' }, at);
  store.journal('shop-checkout', 'liveness-defect', { message: 'supervisor liveness defect' }, at);
  store.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('coordinator_blocked', ?)", reason);
  store.close();
  await page.refresh();
  const findings = [];
  for (const where of ['#/projects', '#/needs', '#/settings', '#/settings/messages', address('example/shop-app')]) {
    await page.go(where);
    for (const found of internalWords(page.text())) findings.push(`${where}: ${found}`);
  }
  assert.deepEqual(findings, []);
  await page.go('#/projects');
  const home = screen(page);
  assert.match(home, /1 step delivered by AI workers/);
  assert.match(home, /2 AI worker runs did not succeed \(1 rejected by the independent checker\); AIWorks retries by itself/);
  assert.match(home, /AIWorks itself had problems \(its own check failed 1 time and was retried; it failed to check in on time 1 time\)\. Not an owner action: these are faults in AIWorks for its maintainers\. AIWorks issue #2 ↗/);
  await page.go('#/needs');
  assert.match(screen(page), /AIWorks cannot read your messages .*Not yours to fix: the AIWorks configuration file on this computer needs a fix by whoever maintains AIWorks\./);
  // The machine's reason is kept, one click away.
  const recorded = nodes(page, 'DETAILS').find((node) => node.textContent.includes(reason));
  assert.ok(recorded, 'the machine reason is inside a details disclosure');
  await page.go('#/settings/messages');
  assert.match(screen(page), /not reading now; why is under Needs me/);
  assert.match(screen(page), /! Not read yet · AIWorks cannot read requests right now; why is under Needs me/);
  assert.doesNotMatch(screen(page), /invalid coordinator configuration/);
});

/** The controls an advice sentence names: "choose Check again", "under More", "choose Open …" (aiworks#11 review 5 G8). */
const namedControls = (text) => [...text.matchAll(/\bchoose (Check again|More|Open [^.,;]+)|\bunder (More)\b/g)].map((m) => m[1] ?? m[2]);
/** Every control in `node` by its visible name: buttons, links and disclosure summaries. */
const controlsIn = (node) => [...node.walk()].filter((item) => ['BUTTON', 'A', 'SUMMARY'].includes(item.tagName)).map((item) => item.textContent.replace(/ ↗$/, '').trim());

test('review 5 G4, G8: Needs me advice is followable from the card: no task name or other internal, and each control it names is on the card', async (t) => {
  const page = await openPage(t);
  await page.go('#/needs');
  const cards = nodes(page, 'LI').filter((node) => node.className.startsWith('needs-item'));
  assert.ok(cards.length > 5, 'the review fixture lists its Needs me items');
  const named = [];
  for (const card of cards) {
    const text = visibleText(card);
    assert.deepEqual(internalWords(text), [], text);
    assert.doesNotMatch(text, /scheduled task|AIWorks Supervisor|start the task/i, text);
    for (const control of namedControls(text)) {
      named.push(control);
      assert.ok(controlsIn(card).includes(control), `“${control}” is named on a card without it: ${text}`);
    }
  }
  assert.ok(named.includes('Check again'), 'the fixture has a card that names Check again');
  // The lapsed check (review 5 G4, second scope): what to do, and who to turn to when that does not help.
  const lapsed = cards.map((card) => visibleText(card)).find((text) => text.includes('AIWorks is running, but last checked on this work'));
  assert.ok(lapsed, 'the lapsed-check card');
  assert.match(lapsed, /If it stays like this, sign out of this computer and sign in again, or restart the computer: AIWorks starts again by itself when you sign in\. If that does not help, whoever set up AIWorks on this computer needs to look at it\./);
  // The stopped work's carried Check again works from the card.
  const stopped = cards.find((card) => visibleText(card).includes('No AI worker on this computer can do this step'));
  assert.match(visibleText(stopped), /What to do: Set up an AI worker that can do it on this computer \(see Settings\), then choose Check again\. Check again$/);
  buttonNamed(page, 'Check again', stopped).click();
  await page.settle();
  assert.equal(visibleText(page.$('#notice')), 'Check again requested. AIWorks looks at this work again; its limits and the independent check still apply.');
  // The same stop on the project's Now carries the same control as its primary action.
  await page.go(address('example/notes-site', '/work'));
  assert.doesNotMatch(screen(page), /under More/);
});
