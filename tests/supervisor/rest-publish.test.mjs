// Publication goes through the GitHub REST API (gh api), never GraphQL, and a rate-limit refusal waits for its reset (aiworks#21).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';
import { findOpenPullRequest, openPullRequest } from '../../src/supervisor/adapters/github.mjs';

const FAKE_GH = join(import.meta.dirname, 'fixtures', 'fake-gh.mjs');
const GRAPHQL_BACKED = (args) => args[0] !== 'api' || args.includes('graphql');

async function setup(t, { config } = {}) {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const env = environment({ config });
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  t.after(() => { store.close(); env.cleanup(); });
  const d = declaration({ tasks: [declaration().tasks[0]] });
  campaignStart(store, d);
  const controller = new Controller({ store, config: env.config, dataDir: env.dataDir, fault: null });
  return { env, store, controller, id: d.campaignId };
}

test('publication uses only REST routes: lookup by owner:branch, then one create', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await setup(t);
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const calls = env.ghCalls().map((call) => call.args);
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter(GRAPHQL_BACKED), [], 'no gh pr, gh issue comment or GraphQL call');
  const branch = `campaign/${id}/T1`;
  const lookup = calls.find((args) => args.includes('repos/example-org/sampleapp/pulls') && args.includes('GET'));
  assert.ok(lookup.includes(`head=example-org:${branch}`) && lookup.includes('state=open'));
  const creates = calls.filter((args) => args.includes('repos/example-org/sampleapp/pulls') && args.includes('POST'));
  assert.equal(creates.length, 1);
  assert.ok(creates[0].includes(`head=${branch}`) && creates[0].includes('base=main'));
  const [pr] = env.prs();
  assert.equal(env.prs().length, 1);
  assert.equal(store.task(id, 'T1').pr_url, pr.url);
  assert.equal(pr.head, branch);
});

test('a create whose response is lost reconciles through the REST lookup: one PR', (t) => {
  const env = environment(); t.after(() => env.cleanup());
  // Wrap the synthetic gh: the create lands, then the response is lost.
  const lossy = join(env.tmp, 'lossy-gh.mjs');
  writeFileSync(lossy, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const out = spawnSync(process.execPath, [${JSON.stringify(FAKE_GH)}, ...args], { encoding: 'utf8' });
if (args.includes('POST') && args.includes('repos/example-org/sampleapp/pulls')) { process.stderr.write('gh: HTTP 502 Bad Gateway'); process.exit(1); }
process.stdout.write(out.stdout); process.stderr.write(out.stderr); process.exit(out.status);`);
  const gh = [process.execPath, lossy];
  const local = { git: [process.execPath, '-e', ''], repoPath: env.tmp, base: 'a'.repeat(40), head: 'b'.repeat(40) };
  const input = { gh, repository: 'example-org/sampleapp', baseBranch: 'main', branch: 'campaign/c/T1', title: 'T1', body: 'body', bodyFile: join(env.tmp, 'body.md'), local };
  const url = openPullRequest(input);
  assert.equal(env.prs().length, 1);
  assert.equal(url, env.prs()[0].url);
  assert.equal(openPullRequest(input), url, 'a retry finds the open PR and creates nothing');
  assert.equal(env.prs().length, 1);
  assert.equal(findOpenPullRequest({ gh, repository: 'example-org/sampleapp', branch: 'campaign/c/other' }), null);
});

test('malformed private publication settings refuse a GitHub publication: nothing is pushed or opened', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await setup(t, { config: { publishRetryMs: 60_000 } });
  writeFileSync(join(env.repo, '.git', 'info', 'exclude'), '.local/\n');
  mkdirSync(join(env.repo, '.local'), { recursive: true });
  writeFileSync(join(env.repo, '.local', 'publication.json'), '{ not json');
  await runUntil(controller, store, id, () => String(store.task(id, 'T1').last_error ?? '').startsWith('publish:'));
  assert.equal(store.task(id, 'T1').state, 'verified');
  assert.match(store.task(id, 'T1').last_error, /Invalid private publication settings/);
  assert.equal(env.prs().length, 0);
  assert.equal(spawnSync('git', ['ls-remote', env.origin, `refs/heads/campaign/${id}/T1`], { encoding: 'utf8', windowsHide: true }).stdout.trim(), '', 'nothing was pushed');
});

// aiworks#8: publication text passes the shared privacy check before any outbound write. Synthetic values are assembled at run
// time so this file passes the public-scope check.
const LEAK_PATH = ['C:', 'Users', 'synthetic-owner', 'sampleapp', 'src', 'work.mjs'].join('\\');
const outbound = (env) => JSON.stringify([env.ghCalls(), env.prs(), env.comments()]);

async function leakSetup(t, scenario) {
  const result = await setup(t);
  result.env.setScenario(scenario);
  return result;
}

test('the GitHub adapter refuses unsafe text before any gh call and never echoes it; the owner-project rule binds only AIWorks', async (t) => {
  const env = environment(); t.after(() => env.cleanup());
  const { publicationFindings } = await import('../../src/shared/public-text.mjs');
  const { postComment } = await import('../../src/supervisor/adapters/github.mjs');
  const gh = [process.execPath, FAKE_GH];
  const bodyFile = join(env.tmp, 'body.md');
  const token = ['ghp', 'A'.repeat(36)].join('_');
  for (const [send, value] of [
    [(body) => postComment({ gh, repository: 'example-org/sampleapp', issue: 1, body, bodyFile }), LEAK_PATH],
    [(body) => postComment({ gh, repository: 'example-org/sampleapp', issue: 1, body, bodyFile }), token],
    [(body) => openPullRequest({ gh, repository: 'example-org/sampleapp', baseBranch: 'main', branch: 'campaign/c/T1', title: 'T1', body, bodyFile }), LEAK_PATH],
    [(body) => postComment({ gh, repository: 'example-org/sampleapp', issue: 1, body, bodyFile, terms: ['fictional-private-host'] }), 'fictional-private-host'],
  ]) {
    assert.throws(() => send(`evidence: ${value}`), (error) => error.code === 'PUBLICATION_TEXT_REFUSED' && !error.message.includes(value));
  }
  assert.deepEqual(env.ghCalls(), [], 'nothing reached gh');
  const sibling = ['netbka', 'sibling-project'].join('/');
  assert.deepEqual(publicationFindings(`see ${sibling} and src/a.mjs`, { repository: 'example-org/sampleapp' }), []);
  assert.deepEqual(publicationFindings(`see ${sibling}`, { repository: 'netbka/aiworks' }), ['another upstream-owner project']);
  for (const root of ['/opt', '/tmp', '/srv', '/var/lib', '/etc', '/usr/local', '/Volumes']) {
    assert.deepEqual(publicationFindings(`log at ${root}/sample-install/run.log`, { repository: 'example-org/sampleapp' }), ['absolute local path'], root);
  }
  assert.deepEqual(publicationFindings('see src/opt/a.mjs, ./tmp/b.log, `GET /repos/o/r/issues/8/comments` and https://example.com/a/b',
    { repository: 'example-org/sampleapp' }), []);
});

test('repeatedly unsafe reports stall within the bound and nothing is published', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await leakSetup(t, { implement: ['commit-leak', 'commit-leak', 'commit-leak', 'commit-leak'], verify: ['accept', 'accept', 'accept', 'accept'] });
  await runUntil(controller, store, id, () => store.task(id, 'T1').blocked?.class === 'stalled');
  for (let i = 0; i < 10; i += 1) await controller.tick();
  assert.ok(env.calls().filter((call) => call.role === 'implement').length <= 3, 'bounded correction rounds');
  assert.equal(env.prs().length, 0);
  assert.equal(env.remoteHead(`campaign/${id}/T1`), null, 'nothing was pushed');
  assert.doesNotMatch(outbound(env), /synthetic-owner/);
});
