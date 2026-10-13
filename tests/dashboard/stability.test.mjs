// A stable, honest page (aiworks#11, UX-002 review of the owner dashboard at 96ed590, findings F4, F8, F12, F20, F21 and
// F25): focus is never hidden under the bottom bar, the header says only whether the page is connected, the recovery a
// stopped step names is visible, a notice stays with the screen it belongs to, the 5-second refresh leaves what the owner
// is pointing at in place, and Start work wears the dialogs' styles. The page is the unchanged dashboard.js on the review
// fixture through the real dashboard server (tests/dashboard/fixtures/page.mjs). Disposable stores, local git and a
// loopback server only: no browser, network, model or GitHub call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../src/supervisor/store.mjs';
import { supervisorSnapshot } from '../../src/dashboard/supervisor.mjs';
import { openPage, visibleText } from './fixtures/page.mjs';
import { PROJECTS } from './fixtures/review-store.mjs';

const CSS = readFileSync(join(resolve(import.meta.dirname, '../..'), 'src/dashboard/public/dashboard.css'), 'utf8');
const address = (project, tail = '') => `#/p/${encodeURIComponent(project)}${tail}`;
const buttonNamed = (page, text, within = page.document.body) => [...within.walk()].find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === text);
// The fake DOM's selectors match tag names of letters only, so headings are found by walking.
const workPanel = (page, title) => page.$('#content').querySelectorAll('section.panel').find((node) => [...node.walk()].some((h) => h.tagName === 'H2' && h.textContent.includes(title)));
const inDetails = (node) => Boolean(node.parentNode?.closest?.('details'));
const shown = (node) => { for (let at = node; at?.nodeType === 1; at = at.parentNode) if (at.hidden) return false; return true; };

/** Rules of a stylesheet as [selectors, declarations], comments left out; `within` limits them to one @media block. */
function rules(css, within = null) {
  let text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (within) {
    const start = text.indexOf(`@media(${within}){`);
    assert.ok(start >= 0, `@media(${within})`);
    let depth = 1, i = start + within.length + 9;
    const from = i;
    while (depth) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
    text = text.slice(from, i - 1);
  } else text = text.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().split(',').map((s) => s.trim()), m[2]]);
}

test('F4: at 320px every focusable element reached with the keyboard is moved fully above the fixed bottom bar', async (t) => {
  // The bar's height, from the stylesheet: a destination's min-height, 4px padding above and below, and its 1px top border.
  const narrow = rules(CSS, 'max-width:959px');
  const item = Number(/min-height:(\d+)px/.exec(narrow.find(([s]) => s.includes('.nav-item'))[1])[1]);
  const bar = item + 4 + 4 + 1;
  assert.equal(bar, 61, 'the bar the reviewer measured: y 659 to 720 in a 720px window');
  // The browser's own focus scrolling leaves room for the bar and the focus ring.
  const html = narrow.find(([s]) => s.includes('html'));
  assert.ok(html, 'a scroll-padding rule for the page at narrow widths');
  assert.ok(Number(/scroll-padding-bottom:(\d+)px/.exec(html[1])[1]) >= bar + 8, html[1]);
  // The page script does the same, whatever the browser: every element the keyboard reaches on Needs me and on a step,
  // placed where the reviewer saw "Tracking issue ↗" (y 655.0 to 673.6), ends up fully above the bar.
  const page = await openPage(t);
  page.$('.sidebar').rect = { top: 720 - bar, bottom: 720 };
  for (const where of ['#/needs', address('example/notes-site', '/step/notes-search/T1'), address('example/shop-app', '/work')]) {
    await page.go(where);
    const focusable = page.$('#main').querySelectorAll('a, button, summary, input, select, textarea').filter((node) => shown(node) && !node.disabled);
    assert.ok(focusable.length > 5, `${where}: ${focusable.length} focusable elements`);
    for (const node of focusable) {
      node.rect = { top: 655, bottom: 673.6 };
      page.window.scrollY = 0;
      node.focus();
      const bottom = 673.6 - page.window.scrollY;
      assert.ok(bottom <= 720 - bar, `${where}: “${node.textContent.trim()}” ends at y ${bottom}, under the bar at y ${720 - bar}`);
      assert.ok(655 - page.window.scrollY >= 0, 'and its top is still in the window');
    }
  }
  // Wide screens: the bar is a sidebar from the top of the window, so focus moves nothing.
  page.$('.sidebar').rect = { top: 0, bottom: 720 };
  const link = page.$('#main').querySelector('a');
  link.rect = { top: 655, bottom: 673.6 };
  page.window.scrollY = 0;
  link.focus();
  assert.equal(page.window.scrollY, 0);
  // No sideways scroll at 320px: nothing added here sets a page-level width.
  for (const [selectors, declarations] of narrow) assert.doesNotMatch(declarations, /(?:^|;)(?:min-)?width:(?:[4-9]\d\d|\d{4,})px/, selectors.join(','));
});

test('F8: the header says only "Connected", on every screen of both stores; merge freshness is on the rows that use it', async (t) => {
  for (const store of ['full', 'empty']) {
    const page = await openPage(t, { store });
    const screens = ['#/projects', '#/needs', '#/settings', '#/settings/messages', '#/settings/diagnostics'];
    if (store === 'full') for (const project of PROJECTS) screens.push(address(project), address(project, '/work'), address(project, '/results'));
    for (const where of screens) {
      await page.go(where);
      await page.refresh();
      assert.equal(visibleText(page.$('#connection')), 'Connected', `${store} ${where}`);
      assert.equal(page.$('#connection').className, 'connection online');
      // Neither the header nor the footer carries a merge note.
      assert.doesNotMatch(visibleText(page.$('.topbar')), /merge|checking|updates every/i, `${store} ${where}`);
      assert.doesNotMatch(visibleText(page.$('footer')), /merge/i, `${store} ${where}`);
    }
  }
  // Each project's row on Settings says how fresh its own merge check is.
  const page = await openPage(t);
  await page.go('#/settings');
  const connections = page.$('#content').querySelectorAll('li').filter((node) => node.dataset.focusScope?.startsWith('connection/'));
  assert.equal(connections.length, PROJECTS.length);
  for (const row of connections) assert.match(visibleText(row), /Merges checked at|Merge check from|Merges not checked yet|No published step to check yet|Merges are not checked/, visibleText(row));
});

test('F12: a stopped step shows Check again beside its primary action, where its sentence names it, and it works', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/notes-site', '/step/notes-search/T1'));
  const panel = page.$('#content').querySelector('section.panel');
  assert.match(visibleText(panel), /Stopped: 5 attempts failed\. Notes search\. It will not retry by itself\. Fix the cause, then check it again\./);
  const check = buttonNamed(page, 'Check again', panel);
  assert.ok(check, 'a Check again button on the step');
  assert.equal(inDetails(check), false, 'not behind a closed disclosure');
  assert.equal(check.disabled, false);
  // Beside the primary action, the step issue, and only once: no More menu repeats it.
  assert.ok(check.parentNode.querySelector('a')?.textContent.includes('Open the step issue'), 'next to "Open the step issue"');
  assert.equal(panel.querySelectorAll('button').filter((node) => node.textContent.trim() === 'Check again').length, 1);
  assert.equal(panel.querySelectorAll('summary').filter((node) => node.textContent === 'More').length, 0);
  check.click();
  await page.settle();
  assert.equal(visibleText(page.$('#notice')), 'Check again requested. AIWorks looks at this work again; its limits and the independent check still apply.');
  // A step that is not stopped keeps it in its More menu.
  await page.go(address('example/shop-app', '/work'));
  const wishlist = workPanel(page, 'Let customers save a wishlist');
  assert.ok(inDetails(buttonNamed(page, 'Check again', wishlist)), 'work-level Check again stays under More');
});

test('F20: a notice stays with the screen of the action it acknowledges, not on other projects', async (t) => {
  const page = await openPage(t);
  const recipes = address('example/recipes', '/work');
  await page.go(recipes);
  buttonNamed(page, 'Resume', workPanel(page, 'Import recipes')).click();
  await page.settle();
  const notice = page.$('#notice');
  assert.equal(notice.hidden, false);
  assert.match(visibleText(notice), /^AIWorks did not resume this work\./);
  for (const elsewhere of [address('example/shop-app'), address('example/shop-app', '/work'), '#/needs', '#/projects']) {
    await page.go(elsewhere);
    assert.equal(notice.hidden, true, `no recipes notice on ${elsewhere}`);
    assert.equal(visibleText(page.$('#main')).includes('AIWorks did not resume this work'), false, elsewhere);
  }
  // Back on the screen it belongs to, it is still there; the refresh does not bring it anywhere else.
  await page.go(recipes);
  assert.equal(notice.hidden, false);
  await page.go(address('example/notes-site'));
  await page.refresh();
  assert.equal(notice.hidden, true);
  // A new action's notice replaces it, on its own screen.
  await page.go(address('example/shop-app', '/work'));
  buttonNamed(page, 'Check again', workPanel(page, 'Let customers save a wishlist')).click();
  await page.settle();
  assert.equal(visibleText(notice), 'Check again requested. AIWorks looks at this work again; its limits and the independent check still apply.');
  await page.go(recipes);
  assert.equal(notice.hidden, true);
});

test('F21: the 5-second refresh keeps what the owner points at, focus, scroll and open disclosures, and still shows changes', async (t) => {
  const page = await openPage(t);
  // Projects: the project links stay the same nodes.
  await page.go('#/projects');
  const links = page.$('#content').querySelectorAll('a.project-name');
  assert.equal(links.length, PROJECTS.length);
  await page.refresh();
  for (const node of links) assert.ok(page.$('#content').contains(node), `${node.textContent} is the same link after the refresh`);
  // Work: Resume, a focused link, an open disclosure and the scroll position survive the refresh.
  await page.go(address('example/recipes', '/work'));
  const panel = workPanel(page, 'Import recipes'), resume = buttonNamed(page, 'Resume', panel);
  const details = panel.querySelector('details[data-disclosure]');
  details.open = true;
  details.dispatchEvent({ type: 'toggle', target: null, preventDefault() {} });
  const step = panel.querySelector('a.task-name');
  step.focus();
  page.window.scrollY = 178;
  await page.refresh();
  await page.refresh();
  assert.ok(page.$('#content').contains(resume), 'Resume is the same button');
  assert.ok(page.$('#content').contains(details) && details.open, 'the disclosure is the same and still open');
  assert.equal(page.document.activeElement, step, 'focus stays on the same link');
  assert.equal(page.window.scrollY, 178);
  // A change still shows: pausing the other piece of work turns its Pause into Resume, and the first Resume stays put.
  const timers = workPanel(page, 'Add cooking timers');
  buttonNamed(page, 'Pause', timers).click();
  await page.settle();
  assert.ok(buttonNamed(page, 'Resume', workPanel(page, 'Add cooking timers')), 'the paused work now offers Resume');
  assert.equal(buttonNamed(page, 'Pause', workPanel(page, 'Add cooking timers')), undefined);
  // While a command is sent every button is off, which is a real change; once it is settled, a refresh keeps them again.
  const again = buttonNamed(page, 'Resume', workPanel(page, 'Import recipes'));
  assert.equal(again.disabled, false);
  await page.refresh();
  assert.ok(page.$('#content').contains(again), 'an unchanged Resume is not replaced');
  // A kept button acts on the work as it is now: when the work's record changed without a visible change, the refresh
  // keeps the button, and its command carries the current version, so it is accepted rather than refused as out of date.
  await page.go(address('example/shop-app', '/work'));
  const wishlist = workPanel(page, 'Let customers save a wishlist'), id = wishlist.dataset.focusScope.replace(/^work\//, '');
  const pause = buttonNamed(page, 'Pause', wishlist);
  const store = new Store(join(page.dataDir, 'supervisor.db'));
  try { store.patch('campaigns', { id }, store.campaign(id).version, {}, Date.now()); } finally { store.close(); }
  await page.refresh();
  assert.ok(page.$('#content').contains(pause), 'Pause is the same button after the record changed');
  pause.click();
  await page.settle();
  assert.equal(visibleText(page.$('#notice')), 'Paused. No new step starts; a step already running may finish.');
  assert.equal(supervisorSnapshot(page.dataDir).campaigns.find((c) => c.id === id).control, 'paused');
});

test('F25: Start work uses the dialogs’ form styles: the box inside its label, the choices in framed groups', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/shop-app', '/start'));
  const form = page.$('form[data-start-form]');
  assert.ok(form.classList.contains('start-form'));
  const goal = form.querySelector('#start-goal');
  assert.equal(goal.parentNode.tagName, 'LABEL', 'the text box is inside its label');
  assert.ok(goal.parentNode.classList.contains('field'));
  assert.equal(goal.parentNode.childNodes[0].textContent, 'What should be true when this is finished?', 'the question comes first');
  const radios = form.querySelectorAll('input[type="radio"]');
  assert.equal(radios.length, 5);
  for (const radio of radios) {
    assert.ok(radio.parentNode.classList.contains('choice'), radio.getAttribute('value'));
    assert.equal(radio.parentNode.parentNode.tagName, 'FIELDSET');
  }
  // The stylesheet gives these the same rules as the dialogs' labels and boxes.
  const all = rules(CSS);
  const same = (dialogSelector, formSelector) => all.find(([s]) => s.includes(dialogSelector))?.[0].includes(formSelector);
  assert.ok(same('dialog label', '.start-form .field'), 'a label with its box is laid out like the dialogs');
  assert.ok(same('dialog textarea', '.start-form textarea'), 'the text box looks like the dialogs');
  assert.ok(all.some(([s, d]) => s.includes('.start-form fieldset') && /border:1px solid/.test(d)), 'framed choice groups');
  const choice = all.find(([s]) => s.includes('.start-form .choice'));
  assert.ok(choice && Number(/min-height:(\d+)px/.exec(choice[1])[1]) >= 44, 'each choice is a 44px touch target');
  // The hidden Number box stays hidden although its label is a grid.
  assert.ok(all.some(([s, d]) => s.includes('.start-form .field[hidden]') && /display:none/.test(d)));
});
