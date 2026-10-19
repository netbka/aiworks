// LO L13 (docs/design/LOCAL_OPERATION.md section 9, slice UI20): the work list's owner routes. A program AIWorks started,
// another origin, a missing token, an oversized or stale request cannot change local work or close an issue on GitHub; a
// confirmation closes exactly the version-bound list it showed, and a retry or a second press does nothing twice.
// Synthetic store, synthetic gh serving one fictional repository, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/supervisor/store.mjs';
import { comments, item } from '../../src/supervisor/work-list.mjs';
import { importIssues } from '../../src/supervisor/work-list-import.mjs';
import { createDashboardServer } from '../../src/dashboard/server.mjs';

const REPOSITORY = 'example-org/aiworks-sample';
const GH = [process.execPath, fileURLToPath(new URL('../supervisor/fixtures/fake-gh-issues.mjs', import.meta.url))];
const roadmap = { snapshot: () => ({ governance: { configured: true, code: null, reason: null }, entries: [] }) };
const lookupAs = (ancestors) => async () => ({ pid: 999_991, ancestors, jobs: [] });
const OWNER = { platform: 'win32', lookup: lookupAs([999_990]) };
// A synthetic AIWorks process: its parent is the process the dashboard runs in.
const WORKER = { platform: 'win32', lookup: lookupAs([process.pid]) };

/** A data directory whose work list holds three issues imported from the synthetic repository. */
function rig(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-dashboard-worklist-'));
  const ghState = mkdtempSync(join(dataDir, 'gh-'));
  process.env.FAKE_GH_STATE = ghState;
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ selfHosting: { repository: REPOSITORY } }));
  const issue = (number) => ({ number, title: `Issue ${number}`, body: `Body ${number}`, state: 'open', html_url: `https://github.com/${REPOSITORY}/issues/${number}`,
    labels: [], updated_at: '2026-10-18T00:00:00Z' });
  writeFileSync(join(ghState, 'issues.json'), JSON.stringify({ open: [1, 2, 3].map(issue), closed: [], comments: {}, writable: true, clock: '2026-10-19T09:00:00Z' }));
  const store = new Store(join(dataDir, 'supervisor.db'));
  importIssues({ store, gh: GH, repository: REPOSITORY, dryRun: false, now: 1_760_000_000_000 });
  store.close();
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const serve = async (callerCheck, workList = {}) => {
    const server = createDashboardServer({ dataDir, roadmap, callerCheck, workList: { gh: GH, ...workList } });
    servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    const send = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { base, send, state: async () => (await (await fetch(`${base}/api/state`)).json()).worklist,
      read: async (number) => (await fetch(`${base}/api/v2/worklist/${number}`)).json() };
  };
  const read = (fn) => { const opened = new Store(join(dataDir, 'supervisor.db'), { readOnly: true }); try { return fn(opened); } finally { opened.close(); } };
  const writes = () => readFileSync(join(ghState, 'gh-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).args)
    .filter((args) => ['POST', 'PATCH'].includes(args[args.indexOf('--method') + 1]));
  return { serve, read, writes, remote: () => JSON.parse(readFileSync(join(ghState, 'issues.json'), 'utf8')) };
}

test('a worker, another origin, a missing token, an oversized or stale request changes no local work and closes nothing', async (t) => {
  const { serve, read, writes } = rig(t);
  const owner = await serve(OWNER, { available: true }), worker = await serve(WORKER, { available: true });
  const { version } = await owner.read(2);
  const comment = (requestId = randomUUID()) => ({ requestId, number: 2, version, body: 'Owner note' });
  const close = { requestId: randomUUID(), typed: REPOSITORY, selection: [{ number: 2, version }] };
  const state = () => read((store) => [item(store, 2).updated_at, comments(store, 2).length, item(store, 2).state]);
  const before = state();

  const refused = async (response, status, code) => { assert.equal(response.status, status); if (code) assert.equal((await response.json()).code, code); };
  for (const [path, body] of [['/api/work-list/comment', comment()], ['/api/work-list/state', { requestId: randomUUID(), number: 2, version, state: 'closed' }],
    ['/api/work-list/items', { requestId: randomUUID(), kind: 'task', title: 'From a worker', body: '' }], ['/api/work-list/close-imported', close]]) {
    await refused(await worker.send(path, body), 403, 'APPROVAL_FROM_AIWORKS');
    await refused(await owner.send(path, body, { Origin: 'http://127.0.0.1:1' }), 403);
    await refused(await owner.send(path, body, { 'X-Dashboard-CSRF': 'not-the-token' }), 403);
    await refused(await owner.send(path, JSON.stringify({ ...body, padding: 'x'.repeat(17_000) })), 413);
  }
  await refused(await owner.send('/api/work-list/comment', { ...comment(), version: 'f'.repeat(64) }), 409, 'WORK_ITEM_CHANGED');
  assert.deepEqual(state(), before);
  assert.equal(read((store) => store.get('SELECT COUNT(*) AS n FROM work_items').n), 3);
  assert.deepEqual(writes(), []);

  // The owner's own comment is saved once, however often it is sent.
  const once = comment();
  assert.equal((await owner.send('/api/work-list/comment', once)).status, 200);
  const again = await owner.send('/api/work-list/comment', once);
  assert.equal((await again.json()).duplicate, true);
  assert.equal(read((store) => comments(store, 2).length), before[1] + 1);
  // The version it was sent with is now stale: a second, different comment against it saves nothing.
  await refused(await owner.send('/api/work-list/comment', comment()), 409, 'WORK_ITEM_CHANGED');
  assert.equal(read((store) => comments(store, 2).length), before[1] + 1);
});

test('a confirmation closes exactly the version-bound list it showed, once, and stays off unless switched on', async (t) => {
  const { serve, writes, remote } = rig(t);
  const off = await serve(OWNER), owner = await serve(OWNER, { available: true });
  const shown = (await owner.state()).imported.candidates;
  assert.deepEqual(shown.map((entry) => entry.number), [1, 2, 3]);
  const selection = shown.filter((entry) => entry.number !== 2).map(({ number, version }) => ({ number, version }));
  const confirm = (body) => owner.send('/api/work-list/close-imported', { requestId: randomUUID(), typed: REPOSITORY, selection, ...body });

  // Switched off, a wrong typed name or one changed entry: the whole list is refused before anything reaches GitHub.
  assert.equal((await (await off.send('/api/work-list/close-imported', { requestId: randomUUID(), typed: REPOSITORY, selection })).json()).code, 'WORK_CLOSE_OFF');
  assert.equal((await (await confirm({ typed: 'example-org/other' })).json()).code, 'WORK_CLOSE_TYPED');
  assert.equal((await (await confirm({ selection: [selection[0], { ...selection[1], version: 'a'.repeat(64) }] })).json()).code, 'WORK_CLOSE_STALE');
  assert.deepEqual(writes(), []);

  const request = { requestId: randomUUID(), typed: REPOSITORY, selection };
  const first = await (await owner.send('/api/work-list/close-imported', request)).json();
  assert.deepEqual([first.closed, first.skipped], [[1, 3], []]);
  const sent = writes().length;
  assert.equal(sent, 4, 'one pointer comment and one close for each confirmed issue');
  // The same press again, and a fresh press of the same list, change nothing on GitHub.
  assert.equal((await (await owner.send('/api/work-list/close-imported', request)).json()).duplicate, true);
  assert.deepEqual((await (await confirm({})).json()).alreadyClosed, [1, 3]);
  assert.equal(writes().length, sent);
  assert.deepEqual(remote().open.map((issue) => issue.number), [2]);
  assert.deepEqual((await owner.state()).imported.candidates.map((entry) => entry.number), [2]);
});
