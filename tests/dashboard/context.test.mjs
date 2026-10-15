// Switching projects keeps the place, and Start work is honest when nothing reads it (aiworks#11, UX-002 review of the
// owner dashboard at 96ed590, findings F5 and F10). F5: opening a project from outside it returns to the screen it was
// left on, with its draft and its scroll (OWNER_WORKSPACE §3.3, §13.3 T10). F10: with no coordinator configured, Start
// work and Messages say in owner words that nothing will read a request, offer no send, and say what to do instead.
// Review 4 (aiworks#11): F11, the tracking issue in Now › Details is a link; F19, "Continue with" offers the project
// with an unsent draft first.
// The page is the unchanged dashboard.js on the review fixture through the real dashboard server
// (tests/dashboard/fixtures/page.mjs). Disposable stores, local git and a loopback server only: no browser, network,
// model or GitHub call.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NOT_READ } from '../../src/dashboard/copy.mjs';
import { openPage, visibleText } from './fixtures/page.mjs';

const address = (project, tail = '') => `#/p/${encodeURIComponent(project)}${tail}`;
const walk = (page) => [...page.document.body.walk()];
/** A link the owner clicks, found by its visible text (and an optional class), the way a person finds it. */
const linkNamed = (page, text, cls = null) => {
  const found = walk(page).find((node) => node.tagName === 'A' && node.textContent.trim() === text && (!cls || node.classList.contains(cls)));
  assert.ok(found, `a link “${text}”`);
  return found;
};
const click = async (page, node) => { node.click(); await page.settle(); };
const buttonNamed = (page, text) => walk(page).find((node) => node.tagName === 'BUTTON' && node.textContent.trim() === text);
const type = (node, text) => { node.value = text; node.dispatchEvent({ type: 'input', target: null, preventDefault() {} }); };

test('F5: switching to another project and back keeps the screen, the draft and the scroll (T10)', async (t) => {
  const page = await openPage(t);
  await page.go('#/projects');
  // shop-app, then its Start work, half-way through a plan request, scrolled down.
  await click(page, linkNamed(page, 'shop-app', 'project-name'));
  assert.equal(page.location.hash, address('example/shop-app'));
  await click(page, linkNamed(page, 'Start work'));
  assert.equal(page.location.hash, address('example/shop-app', '/start'));
  type(page.$('#start-goal'), 'Customers can pay with a saved card');
  page.window.scrollY = 178;
  // To recipes, through Projects: a project not opened yet starts on Now, at its top.
  await click(page, page.$('a[data-global="projects"]'));
  assert.equal(page.location.hash, '#/projects');
  assert.equal(page.window.scrollY, 0, 'Projects was not scrolled before');
  await click(page, linkNamed(page, 'recipes', 'project-name'));
  assert.equal(page.location.hash, address('example/recipes'));
  assert.equal(page.window.scrollY, 0);
  page.window.scrollY = 40;
  // Back to shop-app, through Projects: its Start work again, with the draft and the scroll it was left with.
  await click(page, page.$('a[data-global="projects"]'));
  await click(page, linkNamed(page, 'shop-app', 'project-name'));
  assert.equal(page.location.hash, address('example/shop-app', '/start'), 'the screen shop-app was left on');
  assert.equal(page.$('#view-title').textContent, 'Start work');
  assert.equal(page.$('#start-goal').value, 'Customers can pay with a saved card', 'the draft');
  assert.equal(page.window.scrollY, 178, 'the scroll');
  // A project's name on Needs me opens it the same way.
  await click(page, page.$('a[data-global="needs"]'));
  await click(page, linkNamed(page, 'shop-app'));
  assert.equal(page.location.hash, address('example/shop-app', '/start'));
  // Inside the project, its Now tab still opens Now; a link to Start work then returns to where it was left.
  page.window.scrollY = 178;
  await click(page, linkNamed(page, 'Now', 'tab'));
  assert.equal(page.location.hash, address('example/shop-app'));
  await click(page, linkNamed(page, 'Start work'));
  assert.equal(page.location.hash, address('example/shop-app', '/start'));
  assert.equal(page.window.scrollY, 178, 'the Start work link returns to the scroll it was left at');
  // recipes kept its own place too, and Back still returns to the exact address before it, with its scroll.
  await click(page, page.$('a[data-global="projects"]'));
  await click(page, linkNamed(page, 'recipes', 'project-name'));
  assert.equal(page.location.hash, address('example/recipes'));
  assert.equal(page.window.scrollY, 40);
  await page.go('#/projects');
  assert.equal(page.location.hash, '#/projects', 'Back opens the address it names, not a remembered screen');
  await page.go(address('example/recipes'));
  assert.equal(page.location.hash, address('example/recipes'));
  // An address typed or reloaded is the state: a project's own address opens Now.
  await page.go(address('example/shop-app'));
  assert.equal(page.location.hash, address('example/shop-app'));
  assert.equal(page.$('#view-title').textContent, 'shop-app');
});

test('F10: with nothing to read requests, Start work and Messages say so in owner words, offer no send, and say what to do instead', async (t) => {
  const page = await openPage(t);
  // Nothing reads requests: the review fixture's coordinator is taken out of the configuration.
  const file = join(page.dataDir, 'config.json'), config = JSON.parse(readFileSync(file, 'utf8'));
  delete config.coordinator;
  writeFileSync(file, JSON.stringify(config));
  await page.go(address('example/shop-app', '/start'));
  await page.refresh();
  const form = page.$('form[data-start-form]');
  const note = page.$('[data-not-read]');
  assert.ok(note && form.contains(note), 'the note is on the form');
  const said = visibleText(note);
  assert.equal(said, `${NOT_READ.title} ${NOT_READ.text} ${NOT_READ.instead} ${NOT_READ.setUp} ↗`);
  assert.doesNotMatch(said, /coordinator|supervisor|agent/i, 'owner words only');
  assert.equal(note.querySelector('a').getAttribute('href'), NOT_READ.setUpUrl);
  assert.equal(buttonNamed(page, 'Ask for a plan'), undefined, 'sending is not offered');
  assert.equal(form.querySelectorAll('button').length, 0);
  // The goal can still be written and is kept.
  type(page.$('#start-goal'), 'A shopping list from a recipe');
  await page.refresh();
  assert.equal(page.$('#start-goal').value, 'A shopping list from a recipe');
  // Messages: the same words, and no "New message".
  await page.go('#/settings/messages');
  assert.match(visibleText(page.$('#content')), new RegExp(`^Your messages to AIWorks ${NOT_READ.title.replace('.', '\\.')} `));
  assert.equal(visibleText(page.$('[data-not-read]')), said);
  assert.equal(buttonNamed(page, '✉ New message'), undefined, 'sending is not offered');
  // Invalid reading set-up: said in owner words, the machine's reason only under Details.
  writeFileSync(file, JSON.stringify({ ...config, coordinator: { repositories: 'not-a-list', reportTo: 'example/shop-app#1' } }));
  await page.go(address('example/shop-app', '/start'));
  await page.refresh();
  const invalid = page.$('[data-not-read]');
  assert.ok(visibleText(invalid).startsWith(`${NOT_READ.title} ${NOT_READ.invalid} ${NOT_READ.instead}`), visibleText(invalid));
  assert.equal(buttonNamed(page, 'Ask for a plan'), undefined);
  // Once something reads requests, the same form offers "Ask for a plan" again, with the goal as it was typed.
  writeFileSync(file, JSON.stringify({ ...config, coordinator: { repositories: ['example/shop-app'], reportTo: 'example/shop-app#1' } }));
  await page.refresh();
  assert.equal(page.$('[data-not-read]'), null);
  assert.ok(buttonNamed(page, 'Ask for a plan'), 'sending is offered');
  assert.equal(page.$('#start-goal').value, 'A shopping list from a recipe');
  assert.match(visibleText(page.$('form[data-start-form]')), /The plan appears here\. Nothing is posted to GitHub\./);
  assert.doesNotMatch(visibleText(page.$('form[data-start-form]')), /example\/shop-app#1/);
  await page.go('#/settings/messages');
  assert.ok(buttonNamed(page, '✉ New message'));
});

test('F11: Now › Details shows the tracking issue as a working link with its number (aiworks#11 review 4)', async (t) => {
  const page = await openPage(t);
  await page.go(address('example/shop-app'));
  const details = page.$('details[data-disclosure="now/example/shop-app/details"]');
  assert.ok(details, 'Now has its Details');
  const body = details.childNodes.find((node) => node.tagName === 'DIV');
  const issue = [...body.walk()].find((node) => node.tagName === 'A');
  assert.ok(issue, 'the tracking issue is a link, not text');
  assert.match(issue.textContent, /^tracking issue #\d+ ↗$/);
  assert.match(issue.getAttribute('href'), /^https:\/\/github\.com\/example\/shop-app\/issues\/\d+$/);
  assert.equal(issue.getAttribute('href').split('/').at(-1), issue.textContent.match(/#(\d+)/)[1], 'the link opens the issue it names');
  // The parts read as words joined by " · ", never as a printed list ("a, · ,b").
  assert.match(body.textContent, /^Campaign [\w-]+ · tracking issue #\d+ ↗/);
  assert.doesNotMatch(body.textContent, /,https:|, · ,/);
});

test('F19: "Continue with" offers the project with an unsent draft before the last one opened (OWNER_WORKSPACE §3.3)', async (t) => {
  const page = await openPage(t);
  await page.go('#/projects');
  // shop-app's Start work holds a half-written plan request; recipes is opened after it.
  await click(page, linkNamed(page, 'shop-app', 'project-name'));
  await click(page, linkNamed(page, 'Start work'));
  type(page.$('#start-goal'), 'Customers can pay with a saved card');
  await click(page, page.$('a[data-global="projects"]'));
  await click(page, linkNamed(page, 'recipes', 'project-name'));
  await click(page, page.$('a[data-global="projects"]'));
  const resume = linkNamed(page, 'Continue with shop-app →', 'continue-link');
  assert.match(resume.parentNode.textContent, /Your unsent draft is kept there\./);
  // It returns to the draft, where it was left.
  await click(page, resume);
  assert.equal(page.location.hash, address('example/shop-app', '/start'));
  assert.equal(page.$('#start-goal').value, 'Customers can pay with a saved card');
  // With the draft emptied, the last project opened, recipes, is offered again, without the draft line.
  type(page.$('#start-goal'), '');
  await click(page, page.$('a[data-global="projects"]'));
  const last = linkNamed(page, 'Continue with recipes →', 'continue-link');
  assert.doesNotMatch(last.parentNode.textContent, /unsent draft/);
});
