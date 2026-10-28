// Critical integration: the production tick releases finished projects using
// their own standing authority, exact verifier evidence and real contained commands.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { Controller } from '../../src/supervisor/controller.mjs';
import { campaignStart, campaignStatus } from '../../src/supervisor/api.mjs';
import { releasePass } from '../../src/supervisor/release/controller.mjs';
import { authorityChange } from '../../src/supervisor/release/authority-path.mjs';
import { observeGrant } from '../../src/supervisor/release/grant-source.mjs';
import { parseAuthorization } from '../../src/supervisor/release/authorization.mjs';
import { declaration, GOVERNANCE, skipWithoutSqlite } from './helpers.mjs';

function git(dir, ...args) {
  const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
}
const day = (at) => new Date(at).toISOString().slice(0, 10);
function grant(project, now) {
  return { schema: 'aiworks-release-authorization/1', project, version: 1, revoked: false,
    approval: 'https://github.com/example-org/approvals/issues/1', grantedAt: day(now - 86400000), expiresAt: day(now + 30 * 86400000),
    classes: { 'app-code': ['app.txt'], permissions: ['deploy/AGENTS.md'] },
    destinations: [{ id: 'prod', environment: 'prod', kind: 'deploy', changeClasses: ['app-code'], rollback: 'automatic', checkWindowMinutes: 1,
      commands: Object.fromEntries(['deploy', 'observe', 'check', 'rollback'].map((name) => [name, `ops/${name}.mjs`])) }] };
}
function rig(t) {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-release-loop-')), dataDir = join(root, 'data'), governance = join(root, 'governance');
  mkdirSync(dataDir); cpSync(GOVERNANCE, governance, { recursive: true });
  const store = new Store(join(dataDir, 'supervisor.db'));
  const config = { release: { enabled: true }, governanceRoot: governance, repositories: {}, leaseMs: 3000, integrationPollMs: 60000 };
  const r = { root, store, config, dataDir, governance, offset: 0, projects: [] };
  Object.defineProperty(r, 'clock', { get: () => Date.now() + r.offset, set: (value) => { r.offset = value - Date.now(); } });
  r.controller = () => new Controller({ store, config, dataDir, now: () => r.clock, fault: null });
  t.after(async () => { if (r.c) { await r.c.drainReleases(); r.c.release(); } store.close(); rmSync(root, { recursive: true, force: true }); });
  r.project = (id) => {
    const repo = join(root, id), site = join(root, id + '-site'), origin = join(root, id + '-origin.git');
    mkdirSync(repo); mkdirSync(site); mkdirSync(join(repo, 'ops')); mkdirSync(join(repo, 'deploy'));
    const contract = JSON.parse(readFileSync(join(governance, 'registry/projects/sampleapp.json'), 'utf8'));
    contract.id = id; contract.repository.github = `example-org/${id}`;
    const record = grant(id, r.clock);
    contract.governance.releaseAuthorization = { source: 'deploy/AGENTS.md', approval: record.approval, summary: 'Synthetic standing grant' };
    writeFileSync(join(governance, 'registry/projects', id + '.json'), JSON.stringify(contract));
    writeFileSync(join(repo, 'deploy/AGENTS.md'), JSON.stringify(record));
    const commands = {
      observe: `const live=json('live.json'); console.log('revision: '+live.revision); console.log('digest: '+live.digest); console.log('rollback-ready: '+live.digest);`,
      check: `process.exit(0);`,
      deploy: `write('previous.json',json('live.json')); write('live.json',{revision:process.argv[2],digest:'sha256:new'}); console.log('digest: sha256:new');`,
      rollback: `write('live.json',json('previous.json')); console.log('digest: '+json('previous.json').digest);`,
    };
    for (const [name, body] of Object.entries(commands)) writeFileSync(join(repo, `ops/${name}.mjs`),
      `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const at=n=>${JSON.stringify(site)}+'/'+n; const json=n=>JSON.parse(readFileSync(at(n),'utf8')); const write=(n,v)=>writeFileSync(at(n),JSON.stringify(v));
appendFileSync(at('calls.log'),${JSON.stringify(name + '\n')}); ${body}`);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-qb', 'task'); writeFileSync(join(repo, 'app.txt'), 'verified artifact');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'work'); const verified = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main'); git(repo, 'merge', '--no-ff', '-qm', 'merge', 'task'); const merged = git(repo, 'rev-parse', 'HEAD');
    git(root, 'init', '-q', '--bare', origin); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main');
    writeFileSync(join(site, 'live.json'), JSON.stringify({ revision: base, digest: 'sha256:old' }));
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
    const p = { id, repo, site, base, verified, merged, decl, record,
      calls: () => existsSync(join(site, 'calls.log')) ? readFileSync(join(site, 'calls.log'), 'utf8').trim().split('\n') : [] };
    r.projects.push(p); return p;
  };
  return r;
}

test('the production continuation releases two finished projects exactly once and keeps their command work asynchronous', { skip: skipWithoutSqlite }, async (t) => {
  const r = rig(t), one = r.project('sample-one'), two = r.project('sample-two'); r.c = r.controller();
  for (const p of [one, two]) r.store.journal(p.id, 'merged', { task: 'OLD', sha: p.base, mergeCommit: p.base, reconciled: true }, r.clock);
  for (let n = 0; n < 2; n++) {
    releasePass(r.c);
    assert.ok(r.c.releaseJob, JSON.stringify(r.store.all("SELECT detail FROM journal WHERE kind='release-waiting'")));
    if (n === 0) {
      const p = [one, two].find((item) => item.id === r.c.releaseJob.campaignId);
      // The owner renews authority on main after the task was merged and after
      // admission, before any forward intent. No new work commit is needed.
      writeFileSync(join(p.repo, 'deploy/AGENTS.md'), JSON.stringify({ ...p.record, version: 2 }));
      git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'owner grant renewal'); git(p.repo, 'push', '-q', 'origin', 'main');
    }
    // The pass returns with a pending command job; unrelated controller work can continue.
    const running = r.c.releaseJob.promise;
    r.clock += 1000; await new Promise((done) => setTimeout(done, 1200));
    assert.equal(r.store.all('SELECT * FROM release_activity').length, 1);
    await running;
  }
  for (const p of [one, two]) {
    assert.deepEqual(JSON.parse(readFileSync(join(p.site, 'live.json'), 'utf8')), { revision: p.merged, digest: 'sha256:new' });
    assert.equal(p.calls().filter((n) => n === 'deploy').length, 1);
    assert.equal(campaignStatus(r.store, p.id, r.clock, { config: r.config }).release.complete, true);
  }
  r.c.release(); r.c = r.controller();
  for (let n = 0; n < 4; n++) { r.clock += 61000; releasePass(r.c); await r.c.drainReleases(); }
  assert.equal(r.store.all('SELECT * FROM releases').length, 2);
  assert.equal(r.store.all("SELECT * FROM journal WHERE kind='release-grant-renewed'").length, 1);
  assert.equal(r.store.all('SELECT * FROM release_activity').length, 0);
  for (const p of [one, two]) assert.equal(p.calls().filter((n) => n === 'deploy').length, 1);
});

test('ordinary worker changes cannot amend standing release authority and grant versions cannot regress or revive', (t) => {
  const r = rig(t), p = r.project('sample-grant'); r.c = r.controller();
  writeFileSync(join(p.repo, 'deploy/AGENTS.md'), JSON.stringify({ ...p.record, version: 2 }));
  git(p.repo, 'add', '.'); git(p.repo, 'commit', '-qm', 'unauthorized grant change');
  assert.ok(authorityChange(r.c, p.decl, p.repo, p.merged, git(p.repo, 'rev-parse', 'HEAD')));
  const pointer = { project: p.id, source: 'deploy/AGENTS.md', approval: p.record.approval };
  const observe = (record) => { const bytes = Buffer.from(JSON.stringify(record)); return observeGrant(r.store, pointer,
    { ...parseAuthorization(bytes, { project: p.id, now: r.clock }), bytes }, r.clock); };
  assert.equal(observe(p.record).reason, undefined);
  assert.ok(observe({ ...p.record, destinations: [] }).reason);
  assert.ok(observe({ ...p.record, revoked: true }).reason);
  assert.ok(observe(p.record).reason, 'revocation survives seeing the older non-revoked bytes');
  assert.equal(observe({ ...p.record, version: 2 }).reason, undefined);
  assert.ok(observe(p.record).reason, 'an older grant cannot return');
});
