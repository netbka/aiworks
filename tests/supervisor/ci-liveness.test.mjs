// The merge gate merges a head under ciRepair only after `ci-passed` or `ci-none` (merge.mjs ciMergeable). These tests
// guard the one reader that decides between them: a head with no hosted checks counts as `none` only in a repository
// declared to run none, and only on complete, empty answers with no required status check; anything else fails closed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitChecks } from '../../src/supervisor/adapters/github.mjs';

const repository = 'example-org/sampleapp', sha = 'a'.repeat(40), base = `repos/${repository}`;
const RUNS = `${base}/commits/${sha}/check-runs`, STATUS = `${base}/commits/${sha}/status`;
const PROTECTION = `${base}/branches/main/protection/required_status_checks`;
const empty = { [RUNS]: { total_count: 0, check_runs: [] }, [STATUS]: { state: 'pending', total_count: 0, statuses: [] } };
const notProtected = { status: 404, message: 'Branch not protected' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const routes = join(root, 'routes.json'), cli = join(root, 'gh.mjs');
  // gh api --include --method GET <route> ...: answers from routes.json; a route it does not list fails like a network error.
  writeFileSync(cli, `import { readFileSync } from 'node:fs';
    const route = process.argv.slice(3).find((arg) => arg.startsWith('repos/'));
    const answer = JSON.parse(readFileSync(process.argv[2], 'utf8'))[route];
    if (!answer) { console.error('gh: connection refused'); process.exit(1); }
    const status = answer.status ?? 200, body = answer.status ? { message: answer.message } : answer;
    process.stdout.write('HTTP/2.0 ' + status + ' X\\r\\nContent-Type: application/json\\r\\n\\r\\n' + JSON.stringify(body));
    if (status >= 300) { console.error('gh: ' + answer.message + ' (HTTP ' + status + ')'); process.exit(1); }`);
  return (answers, noHostedChecks = true) => {
    writeFileSync(routes, JSON.stringify(answers));
    return commitChecks({ gh: [process.execPath, cli, routes], repository, sha, baseBranch: 'main', noHostedChecks });
  };
}

test('a locally verified head in a repository declared to run no hosted checks settles as having no CI', (t) => {
  const read = fixture(t);
  assert.equal(read({ ...empty, [PROTECTION]: notProtected }).state, 'none');
  assert.equal(read({ ...empty, [PROTECTION]: { status: 404, message: 'Required status checks not enabled' } }).state, 'none');
  assert.equal(read({ ...empty, [PROTECTION]: { strict: false, contexts: [], checks: [] } }).state, 'none');
  // A non-Actions provider that reports a commit status is read too: its success lets the head pass.
  assert.equal(read({ ...empty, [STATUS]: { state: 'success', total_count: 1, statuses: [{ context: 'ext/ci', state: 'success' }] } }, false).state, 'success');
});

test('an unknown, pending, failing, truncated or required-but-missing CI result never counts as passed or none', (t) => {
  const read = fixture(t);
  const status = (state) => ({ [STATUS]: { state, total_count: 1, statuses: [{ context: 'ext/ci', state }] } });
  const run = (status, conclusion = null) => ({ [RUNS]: { total_count: 1, check_runs: [{ name: 'build', status, conclusion }] } });
  // Without the declaration, empty answers are checks that have not appeared yet, however long it has been.
  assert.equal(read({ ...empty, [PROTECTION]: notProtected }, false).state, 'pending');
  // Declared, but the base requires a status check that has not reported.
  assert.deepEqual(read({ ...empty, [PROTECTION]: { contexts: ['ext/ci'], checks: [] } }), { state: 'pending',
    checks: [{ name: 'ext/ci', status: 'expected', conclusion: null, url: null }] });
  assert.equal(read({ ...empty, [PROTECTION]: { contexts: [], checks: [{ context: 'build', app_id: 1 }] } }).state, 'pending');
  // A protection read that fails, or a bare 404 that does not say the branch requires nothing, is never "none required".
  assert.throws(() => read({ ...empty, [PROTECTION]: { status: 404, message: 'Not Found' } }));
  assert.throws(() => read({ ...empty, [PROTECTION]: { status: 403, message: 'Must have admin rights to Repository.' } }));
  assert.throws(() => read(empty));
  assert.throws(() => read({ ...empty, [STATUS]: { message: 'no statuses field' }, [PROTECTION]: notProtected }));
  // Truncated answers: a count above what the page holds is never read as empty.
  assert.equal(read({ ...empty, [RUNS]: { total_count: 3, check_runs: [] }, [PROTECTION]: notProtected }).state, 'pending');
  assert.equal(read({ ...empty, [STATUS]: { state: 'pending', total_count: 2, statuses: [] }, [PROTECTION]: notProtected }).state, 'pending');
  assert.equal(read({ ...empty, ...run('completed', 'success'), [RUNS]: { total_count: 101, check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } }).state, 'inconclusive');
  // Declared or not, a pending or failing check run or commit status keeps its state.
  for (const declared of [true, false]) {
    const with404 = { [PROTECTION]: notProtected };
    assert.equal(read({ ...empty, ...status('pending'), ...with404 }, declared).state, 'pending');
    assert.equal(read({ ...empty, ...status('failure'), ...with404 }, declared).state, 'failure');
    assert.equal(read({ ...empty, ...status('error'), ...with404 }, declared).state, 'failure');
    assert.equal(read({ ...empty, ...run('in_progress'), ...with404 }, declared).state, 'pending');
    assert.equal(read({ ...empty, ...run('completed', 'failure'), ...status('success'), ...with404 }, declared).state, 'failure');
    assert.equal(read({ ...empty, ...run('completed', 'cancelled'), ...with404 }, declared).state, 'inconclusive');
  }
});
