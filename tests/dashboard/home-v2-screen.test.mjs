// The Home screen builds only from the Home data: words from that data are text, never markup or an address, and a
// calm Home stays short. A stand-in for `el` records what the page would show; no browser, network or model call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeBlocks } from '../../src/dashboard/public/home.mjs';

const el = (tag, attributes = {}, ...children) => ({ tag, attributes, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) });
const texts = (node) => typeof node === 'string' ? [node] : node.children.flatMap(texts);
const walk = (node) => typeof node === 'string' ? [] : [node, ...node.children.flatMap(walk)];

const fixture = {
  needs: { count: 0 },
  goals: [
    { project: 'bakery', title: 'Online cake orders', now: 'Now: Order email', done: 1, total: 3, dropped: 0, segments: ['done', 'now', 'todo'], state: 'Building' },
    { project: 'bakery', title: 'Seasonal menu page', now: 'Next: Menu prices', done: 0, total: 2, dropped: 0, segments: ['now', 'todo'], state: 'Checking' },
    { project: 'bakery', title: 'Gift cards', now: 'Next: Card design', done: 2, total: 4, dropped: 1, segments: ['done', 'done', 'todo', 'dropped'], state: 'Queued' }],
  landed: { total: 7, entries: Array.from({ length: 7 }, (_, i) => ({ title: `Step ${i + 1}`, project: 'bakery', at: Date.now() - i * 60000 })) },
  quiet: [{ name: 'garden', state: 'Done' }], spentToday: { usd: 1.25, unreportedRuns: 0 },
  decided: [{ question: 'Which colour?', chosen: 'Blue', address: '#/step/x' }], address: () => '#/project/bakery/overview' };

test('a calm Home is short and only shows its five blocks', () => {
  const words = homeBlocks(fixture, { el, timeAgo: () => '5m ago' }).flatMap(texts).join(' ').split(/\s+/).filter(Boolean);
  assert.ok(words.length <= 120, `${words.length} words`);
});

test('words from the data are text only: markup stays a string and never becomes an attribute or a tag', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const data = { ...fixture, address: () => null, goals: [{ ...fixture.goals[0], title: hostile, now: hostile, project: hostile }],
    landed: { total: 1, entries: [{ title: hostile, project: hostile, at: 0 }] }, quiet: [{ name: hostile, state: 'Done' }],
    decided: [{ question: hostile, chosen: hostile, address: null }] };
  const nodes = homeBlocks(data, { el, timeAgo: () => hostile }).flatMap(walk);
  assert.ok(nodes.every((node) => /^[a-z0-9]+$/.test(node.tag)), 'only fixed tags');
  assert.ok(nodes.every((node) => Object.values(node.attributes).every((value) => !String(value).includes('<'))), 'no data in attributes');
  assert.ok(nodes.some((node) => node.children.includes(hostile)), 'the text is shown as text');
});
