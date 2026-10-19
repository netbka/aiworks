// Publication goes through the GitHub REST API (gh api), never GraphQL, and a rate-limit refusal waits for its reset (aiworks#21).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';
import { findOpenPullRequest, openPullRequest, parseResponse, rateLimitReset } from '../../src/supervisor/adapters/github.mjs';

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

test('the synthetic gh refuses every GraphQL-backed command', (t) => {
  const env = environment(); t.after(() => env.cleanup());
  for (const args of [['pr', 'list', '--repo', 'example-org/sampleapp', '--head', 'b'], ['pr', 'create', '--repo', 'example-org/sampleapp'],
    ['pr', 'view', '1', '--repo', 'example-org/sampleapp'], ['issue', 'comment', '1', '--repo', 'example-org/sampleapp'], ['api', 'graphql', '-f', 'query={viewer{login}}']]) {
    const out = spawnSync(process.execPath, [FAKE_GH, ...args], { env: { ...process.env, ...env.env }, encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 9, `gh ${args.join(' ')} must be refused`);
  }
});

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
  const input = { gh, repository: 'example-org/sampleapp', baseBranch: 'main', branch: 'campaign/c/T1', title: 'T1', body: 'body', bodyFile: join(env.tmp, 'body.md') };
  const url = openPullRequest(input);
  assert.equal(env.prs().length, 1);
  assert.equal(url, env.prs()[0].url);
  assert.equal(openPullRequest(input), url, 'a retry finds the open PR and creates nothing');
  assert.equal(env.prs().length, 1);
  assert.equal(findOpenPullRequest({ gh, repository: 'example-org/sampleapp', branch: 'campaign/c/other' }), null);
});

test('rate-limit refusals are recognised with their reset time; other failures are not', () => {
  const now = 1_800_000_000_000;
  const limited = parseResponse('HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1800000120\r\n\r\n{"message":"API rate limit exceeded"}');
  assert.equal(limited.status, 403);
  assert.equal(rateLimitReset(limited, '', now), 1_800_000_120_000);
  const secondary = parseResponse('HTTP/2.0 403 Forbidden\r\nRetry-After: 60\r\nX-Ratelimit-Remaining: 12\r\n\r\n{"message":"You have exceeded a secondary rate limit"}');
  assert.equal(rateLimitReset(secondary, '', now), now + 60_000);
  assert.equal(rateLimitReset(parseResponse('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 5\r\n\r\n{}'), '', now), now + 5000);
  assert.equal(rateLimitReset(parseResponse(''), 'gh: API rate limit exceeded (HTTP 403)', now), null, 'a refusal without a reset time');
  for (const text of ['HTTP/2.0 422 Unprocessable Entity\r\n\r\n{"message":"Validation Failed"}', 'HTTP/2.0 404 Not Found\r\n\r\n{}',
    'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 4000\r\n\r\n{"message":"Resource not accessible by integration"}', '']) {
    assert.equal(rateLimitReset(parseResponse(text), 'gh: failed', now), undefined, text);
  }
});

async function rateLimitedPublication(t, limit) {
  const margin = 300;
  const { env, store, controller, id } = await setup(t, { config: { publishRetryMs: 200, rateLimitMarginMs: margin } });
  env.rateLimit({ times: 1, ...limit });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const waits = store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'publish-rate-limited'", id);
  assert.equal(waits.length, 1, 'one refusal, one recorded wait');
  const calls = env.ghCalls();
  assert.deepEqual(calls.map((call) => call.args).filter(GRAPHQL_BACKED), []);
  const route = (call) => call.args.includes('repos/example-org/sampleapp/pulls') && call.args.includes(limit.route.split(' ')[0]);
  const [refused, retried, ...more] = calls.filter(route);
  assert.equal(more.length, 0, 'the refused call is repeated once, after the reset');
  const { retryAt } = waits[0].detail;
  const resetAt = limit.retryAfter !== undefined ? refused.at + limit.retryAfter * 1000 : limit.reset * 1000;
  assert.ok(retryAt >= resetAt + margin - 1000, `waits until the reset plus margin (${retryAt - refused.at} ms)`);
  assert.ok(retried.at >= retryAt, `no publication attempt before the recorded reset (${retried.at - retryAt} ms)`);
  assert.equal(env.prs().length, 1, 'no duplicate PR');
  assert.equal(store.task(id, 'T1').state, 'done');
  assert.equal(store.task(id, 'T1').pr_url, env.prs()[0].url);
}

test('a rate-limited create waits for Retry-After plus a margin, then publishes once', { skip: skipWithoutSqlite }, async (t) => {
  await rateLimitedPublication(t, { route: 'POST pulls', retryAfter: 2 });
});

test('a rate-limited lookup waits for X-RateLimit-Reset plus a margin, then publishes once', { skip: skipWithoutSqlite }, async (t) => {
  await rateLimitedPublication(t, { route: 'GET pulls', reset: Math.ceil(Date.now() / 1000) + 3 });
});

test('a failure that is not a rate limit keeps the fixed publish retry', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await setup(t, { config: { publishRetryMs: 60_000 } });
  const failing = join(env.tmp, 'failing-gh.mjs');
  writeFileSync(failing, `process.stdout.write('HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n{}'); process.stderr.write('gh: HTTP 502'); process.exit(1);`);
  controller.cmd.gh = [process.execPath, failing];
  await runUntil(controller, store, id, () => String(store.task(id, 'T1').last_error ?? '').startsWith('publish:'));
  const task = store.task(id, 'T1');
  assert.equal(task.state, 'verified');
  assert.doesNotMatch(task.last_error, /rate limit/);
  assert.ok(task.retry_at - task.updated_at >= 59_000 && task.retry_at - task.updated_at <= 60_000, 'retries after publishRetryMs');
  assert.equal(store.all("SELECT * FROM journal WHERE campaign_id = ? AND kind = 'publish-rate-limited'", id).length, 0);
  assert.equal(env.prs().length, 0);
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

test('an unsafe implementer report is never pushed or published; a publication repair publishes the corrected report at the same head', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await leakSetup(t, { implement: ['commit-leak', 'commit-same'], verify: ['accept', 'accept'] });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  const [refused, ...more] = store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'publication-refused'", id);
  assert.equal(more.length, 0);
  assert.equal(refused.detail.repair, true);
  assert.ok(refused.detail.sources.includes('report'));
  assert.doesNotMatch(JSON.stringify(refused.detail), /synthetic-owner/);
  assert.doesNotMatch(outbound(env), /synthetic-owner/, 'no gh call, PR or comment carries the refused text');
  const task = store.task(id, 'T1');
  const [pr] = env.prs();
  assert.equal(env.prs().length, 1);
  assert.equal(task.verified_sha, refused.detail.sha, 'the same verified head');
  assert.equal(env.remoteHead(`campaign/${id}/T1`), task.verified_sha);
  assert.ok(pr.body.includes(task.verified_sha) && pr.body.includes('# tests 1'), 'exact head and actual tallies are published');
  const original = store.all("SELECT outcome FROM operations WHERE campaign_id = ? AND id LIKE '%.implement.%' ORDER BY created_at", id)[0];
  assert.ok(JSON.stringify(original.outcome).includes('synthetic-owner'), 'the refused report stays in private run evidence');
  assert.equal(env.calls().filter((call) => call.role === 'implement').length, 2);
});

test('an unsafe verification alone goes to a fresh verifier of the same head', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await leakSetup(t, { implement: ['commit'], verify: ['accept-leak', 'accept'] });
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  assert.deepEqual(store.all("SELECT detail FROM journal WHERE campaign_id = ? AND kind = 'publication-refused'", id).map((row) => row.detail.sources), [['verification']]);
  assert.equal(env.calls().filter((call) => call.role === 'implement').length, 1, 'the implementer is not run again');
  assert.equal(env.calls().filter((call) => call.role === 'verify').length, 2);
  assert.equal(env.prs().length, 1);
  assert.doesNotMatch(outbound(env), /synthetic-owner/);
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

test('an unsafe outbox note is refused once, never retried, and a note without its text is posted instead', { skip: skipWithoutSqlite }, async (t) => {
  const { env, store, controller, id } = await setup(t);
  controller.enqueue(id, `${id}:synthetic-note`, store.campaign(id).declaration, `blocked: see ${LEAK_PATH}`, Date.now());
  await runUntil(controller, store, id, (c) => c.control === 'finished');
  for (let i = 0; i < 5; i += 1) await controller.tick();
  const row = store.get('SELECT state, attempts FROM outbox WHERE key = ?', `${id}:synthetic-note`);
  assert.deepEqual({ ...row }, { state: 'refused', attempts: 0 });
  assert.doesNotMatch(outbound(env), /synthetic-owner/);
  assert.equal(env.comments().filter((comment) => comment.body.includes('was withheld')).length, 1);
});
