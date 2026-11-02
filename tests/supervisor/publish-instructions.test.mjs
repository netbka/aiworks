// Critical: a project without a standing grant is published by its own publication instructions (AW-018), at exactly
// the merged revision, once; a failed check rolls back where the instructions say how; a restart never repeats a
// publication whose outcome is unknown; a project without followable instructions, or a result that rewrites its own
// publishing steps, runs nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
import { releasePass } from '../../src/supervisor/release/controller.mjs';
import { findInstructions, INSTRUCTIONS_DESTINATION, pinInstructions, PUBLISH_RECORD, treeReader } from '../../src/supervisor/release/instructions.mjs';
import { acquireLock, createRelease } from '../../src/supervisor/release/state.mjs';
import { releasePath } from '../../src/supervisor/release/paths.mjs';
import { declaration, GOVERNANCE, skipWithoutSqlite } from './helpers.mjs';

function git(dir, ...args) {
  const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
}

const STEPS = `# Publishing

Install and publish:

\`\`\`sh
npm run deploy
\`\`\`

Read the live revision with \`node ops/live.mjs\`.

Then check the site with \`node ops/check.mjs\`.

To roll back, run \`node ops/rollback.mjs\`.
`;

function rig(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-publish-')), dataDir = join(root, 'data'), governance = join(root, 'governance');
  mkdirSync(dataDir); cpSync(GOVERNANCE, governance, { recursive: true });
  const store = new Store(join(dataDir, 'supervisor.db'));
  const config = { release: { enabled: true }, governanceRoot: governance, repositories: {}, leaseMs: 3000, integrationPollMs: 60000 };
  const r = { root, store, config, dataDir, offset: 0 };
  Object.defineProperty(r, 'clock', { get: () => Date.now() + r.offset, set: (value) => { r.offset = value - Date.now(); } });
  r.controller = () => new Controller({ store, config, dataDir, now: () => r.clock, fault: null });
  r.pass = async (c) => { r.clock += 61_000; await releasePass(c); await c.drainReleases(); };
  t.after(async () => { if (r.c) { await r.c.drainReleases(); r.c.release(); } store.close(); rmSync(root, { recursive: true, force: true }); });
  /** A finished campaign whose one checked task was merged. `steps` is the publication text; `work` changes files in the task. */
  r.project = (id, { steps = STEPS, work = {} } = {}) => {
    const repo = join(root, id), site = join(root, id + '-site'), origin = join(root, id + '-origin.git');
    mkdirSync(repo); mkdirSync(site); mkdirSync(join(repo, 'ops'));
    const contract = JSON.parse(readFileSync(join(governance, 'registry/projects/sampleapp.json'), 'utf8'));
    contract.id = id; contract.repository.github = `example-org/${id}`;
    delete contract.governance.releaseAuthorization; // no standing grant: the instructions are the grant
    writeFileSync(join(governance, 'registry/projects', id + '.json'), JSON.stringify(contract));
    if (steps !== null) writeFileSync(join(repo, 'PUBLISHING.md'), steps);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: id, private: true, scripts: { deploy: 'node ops/deploy.mjs' } }));
    const commands = {
      deploy: `write('previous.json',json('live.json')); write('live.json',{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()});`,
      live: `console.log('revision: '+json('live.json').revision);`,
      check: `process.exit(existsSync(at('broken'))?1:0);`,
      rollback: `write('live.json',json('previous.json'));`,
    };
    for (const [name, body] of Object.entries(commands)) writeFileSync(join(repo, `ops/${name}.mjs`),
      `import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
const at=n=>${JSON.stringify(site)}+'/'+n; const json=n=>JSON.parse(readFileSync(at(n),'utf8')); const write=(n,v)=>writeFileSync(at(n),JSON.stringify(v));
appendFileSync(at('calls.log'),${JSON.stringify(name + '\n')}); ${body}`);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-qb', 'task');
    for (const [path, text] of Object.entries({ 'app.txt': 'checked work', ...work })) writeFileSync(join(repo, path), text);
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'work'); const verified = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main'); git(repo, 'merge', '--no-ff', '-qm', 'merge', 'task'); const merged = git(repo, 'rev-parse', 'HEAD');
    git(root, 'init', '-q', '--bare', origin); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main');
    writeFileSync(join(site, 'live.json'), JSON.stringify({ revision: base }));
    config.repositories[`example-org/${id}`] = { path: repo, worktreeRoot: join(root, id + '-work') };
    const decl = declaration({ campaignId: id, tasks: [{ id: 'T1', issue: 1, title: 'app', deliverable: 'commit', goal: 'Update app',
      dependsOn: [], acceptance: ['artifact works'], references: ['AGENTS.md'] }] });
    decl.target.projectId = id; decl.target.repository = `example-org/${id}`;
    campaignStart(store, decl, r.clock);
    const report = 'synthetic verified report', reportDigest = createHash('sha256').update(report).digest('hex');
    const verification = { verdict: 'accepted', targetSha: verified, reportDigest, findings: [], gate: { exit: '0' },
      criteria: [{ criterion: 1, result: 'pass', check: 'synthetic local check', evidence: 'passed' }] };
    store.run("UPDATE tasks SET state='done', base_sha=?, head_sha=?, verified_sha=?, result=?, verification=? WHERE campaign_id=?", base, verified, verified,
      { result: 'resolved', report }, verification, id);
    store.run("UPDATE campaigns SET control='finished', status='ready' WHERE id=?", id);
    for (const kind of ['implement', 'verify']) store.insert('operations', { id: `${id}-${kind}`, campaign_id: id, task_id: 'T1', kind,
      seq: 1, idempotency_key: `${id}-${kind}`, lease_generation: 1, state: 'finished', session_id: `${id}-${kind}`, run_dir: root, workspace: repo,
      target_sha: kind === 'verify' ? verified : null, packet: {}, packet_digest: 'synthetic', outcome: { class: 'result', value: kind === 'verify' ? verification : { result: 'resolved' } },
      created_at: r.clock, updated_at: r.clock });
    store.journal(id, 'merged', { task: 'T1', sha: verified, mergeCommit: merged }, r.clock);
    return { id, repo, site, base, verified, merged, live: () => JSON.parse(readFileSync(join(site, 'live.json'), 'utf8')).revision,
      calls: () => existsSync(join(site, 'calls.log')) ? readFileSync(join(site, 'calls.log'), 'utf8').trim().split('\n') : [] };
  };
  r.finished = (id) => r.store.all("SELECT detail FROM journal WHERE campaign_id=? AND kind='publish-finished' ORDER BY seq", id).map((row) => row.detail);
  r.followUps = (id) => r.store.all("SELECT number FROM work_items WHERE campaign_id=? AND author_kind='supervisor' AND kind='task'", id);
  return r;
}

test('a merged result is published once by the project\'s own instructions at exactly the merged revision', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t), p = r.project('sample-pub'); r.c = r.controller();
  await r.pass(r.c);
  assert.equal(p.live(), p.merged, 'the merged revision is what is live');
  const [done] = r.finished(p.id);
  assert.equal(done.state, 'accepted');
  assert.equal(done.liveRevision, p.merged);
  assert.equal(done.check, 'passed');
  r.c.release(); r.c = r.controller();
  for (let n = 0; n < 3; n++) await r.pass(r.c);
  assert.equal(p.calls().filter((name) => name === 'deploy').length, 1, 'published exactly once');
  assert.equal(r.store.all('SELECT * FROM releases').length, 1);
});

test('a failed check rolls back by the instructions and records a follow-up item', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t), p = r.project('sample-broken'); r.c = r.controller();
  writeFileSync(join(p.site, 'broken'), '');
  for (let n = 0; n < 2; n++) await r.pass(r.c);
  assert.equal(p.live(), p.base, 'the previous revision is live again');
  assert.deepEqual(p.calls().filter((name) => ['deploy', 'rollback'].includes(name)), ['deploy', 'rollback']);
  const [done] = r.finished(p.id);
  assert.equal(done.state, 'rolled-back');
  assert.equal(done.check, 'failed');
  assert.equal(r.followUps(p.id).length, 1);
});

test('after a restart a publication whose outcome is unknown is never run again', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t), p = r.project('sample-crash');
  // A controller that recorded the publish intent and stopped before any outcome.
  const lease = { instanceId: 'stopped-instance', generation: r.store.acquireLease(p.id, 'stopped-instance', r.clock, r.config.leaseMs).generation };
  const row = createRelease(r.store, { project: p.id, destination: INSTRUCTIONS_DESTINATION, campaignId: p.id, taskId: 'T1', verifiedSha: p.verified,
    steps: ['deploy', 'check'], lease, now: r.clock });
  const instructions = findInstructions(treeReader({ repoPath: p.repo, revision: p.merged }));
  pinInstructions(r.dataDir, row, { ...instructions, revision: p.merged });
  r.store.run('UPDATE releases SET merge_commit=? WHERE id=?', p.merged, row.id);
  acquireLock(r.store, row.id, { lease, now: r.clock, recheck: () => ({ eligible: true, failed: [], inputs: {} }) });
  const key = `${row.id}.deploy.1`;
  r.store.run("UPDATE releases SET state='deploying', step='deploy', step_key=?, step_started_at=?, step_outcome=NULL, history=? WHERE id=?",
    key, r.clock, [{ key, step: 'deploy', startedAt: r.clock, endedAt: null, outcome: null }], row.id);
  writeFileSync(releasePath(r.dataDir, row.id, PUBLISH_RECORD), JSON.stringify({ version: 1, release: row.id, revision: p.merged,
    source: instructions.source, digest: instructions.digest, steps: instructions.steps, publish: 'started', check: null, rollback: 'not-started', liveRevision: null, runs: 1 }));
  r.c = r.controller();
  for (let n = 0; n < 3; n++) await r.pass(r.c);
  assert.equal(p.calls().includes('deploy'), false, 'the publishing steps are not run again');
  assert.equal(r.store.get('SELECT state FROM releases WHERE id=?', row.id).state, 'unknown');
  assert.deepEqual(r.finished(p.id).map((detail) => detail.state), ['unknown']);
  assert.equal(r.followUps(p.id).length, 1);
});

test('nothing is published without followable instructions or when a result rewrites its own publishing steps', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t);
  const none = r.project('sample-none', { steps: null });
  const remote = r.project('sample-remote', { steps: 'Deploy:\n\n```sh\nnpm run deploy\nssh example-host restart\n```\n' });
  const rewritten = r.project('sample-rewrite', { work: { 'PUBLISHING.md': STEPS.replace('npm run deploy', 'npm run deploy\nnode ops/rollback.mjs') } });
  r.c = r.controller();
  for (let n = 0; n < 4; n++) await r.pass(r.c);
  for (const p of [none, remote, rewritten]) assert.deepEqual(p.calls(), [], `${p.id}: nothing ran`);
  assert.equal(r.store.all('SELECT * FROM releases').length, 0);
  const skipped = (id) => r.store.all("SELECT detail FROM journal WHERE campaign_id=? AND kind='publish-skipped'", id);
  for (const p of [none, remote, rewritten]) assert.equal(skipped(p.id).length, 1, `${p.id}: the reason is recorded once`);
  assert.equal(r.followUps(rewritten.id).length, 1);
});
