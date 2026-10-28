// The disposable release rehearsal (docs/design/AUTO_RELEASE.md slice R12 first half, plan slice REL11; owner decision (j)
// of docs/PROJECT_WORKSPACE_PLAN.md section 8: "a disposable rehearsal comes first"). It runs whole releases of exact
// verified revisions through the production release code, end to end, against a destination that exists only for it:
// - a disposable Git repository holds a synthetic grant (release/aiworks-release.json) and four project commands
//   (ops/observe.mjs, deploy.mjs, check.mjs, rollback.mjs) that act on a disposable folder standing in for a site;
// - the grant is read by loadAuthorization at a ref, eligibility is evaluateEligibility with the E1 to E13 checks, the
//   switches are releaseSwitches and releaseGate, state, lock and reconciliation are release/state.mjs, the steps are
//   release/deploy.mjs, every project command runs through release/runner.mjs in its own clean process, and Check the
//   site now is release/health.mjs;
// - the merge gate's `merged` event is journalled by the rehearsal, as merge.mjs journals it after its own merge;
// - evidence only a running installation holds is synthetic and said to be: the governance pointer (E3), the
//   verifier's sessions (E4), the required checks (E8), the dependencies (E10) and the owner-reserved report (E13).
// The configuration (`release.enabled: true`) is an object in memory and the data directory is disposable: it reads and
// writes no installation data, starts no service, touches no provider and makes no network call. Each scenario reports
// what it expected and what it observed; `passed` is true only when every expectation held.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { loadAuthorization } from './authorization.mjs';
import { deployAdapter } from './deploy.mjs';
import { evaluateEligibility, mergedEventReader } from './eligibility.mjs';
import { checkReleaseNow } from './health.mjs';
import { acquireLock, createRelease, destinationState, markUnknownAfterRestart, nextStep, reconcile, release, releaseGate,
  releaseSwitches, RELEASE_STOP, runStep, setReviewOnly } from './state.mjs';

const PROJECT = 'sample-site';
const DESTINATION = 'site';
const CAMPAIGN = 'release-rehearsal';
const GRANT_PATH = 'release/aiworks-release.json';
const REPOSITORY = 'example-org/sample-site';
const MERGE_GATE = Object.freeze({ repository: REPOSITORY, merges: { delegatedTo: 'supervisor', repositories: [REPOSITORY] } });
const LEASE_MS = 3_600_000;
const DAY = 86_400_000;
const ENABLED = Object.freeze({ release: { enabled: true } });

/** The digest the synthetic deploy command prints for a revision. */
const digestOf = (revision) => `sha256:${createHash('sha256').update(revision).digest('hex')}`;
const isoDay = (time) => new Date(time).toISOString().slice(0, 10);

/** The synthetic project commands. Each logs its call to the site folder, then acts on it as `faults.json` says. */
const COMMANDS = {
  observe: `const live = json('live.json');
if ((faults.observeUnreadable ?? []).includes(live.revision)) process.exit(2);
console.log('revision: ' + live.revision); console.log('digest: ' + live.digest);
if (existsSync(at('artifacts/' + live.digest.slice(7) + '.json'))) console.log('rollback-ready: ' + live.digest);`,
  deploy: `const revision = process.argv[2];
const digest = 'sha256:' + createHash('sha256').update(revision).digest('hex');
mkdirSync(at('artifacts'), { recursive: true });
writeFileSync(at('artifacts/' + digest.slice(7) + '.json'), JSON.stringify({ revision, digest }));
writeFileSync(at('live.json'), JSON.stringify({ revision, digest }));
console.log('digest: ' + digest);`,
  check: `const live = json('live.json');
process.exit(faults.down === true || (faults.failDigests ?? []).includes(live.digest) ? 1 : 0);`,
  rollback: `const file = at('artifacts/' + String(process.argv[2]).replace('sha256:', '') + '.json');
if (!existsSync(file)) process.exit(1);
const previous = JSON.parse(readFileSync(file, 'utf8'));
writeFileSync(at('live.json'), JSON.stringify(previous));
console.log('digest: ' + previous.digest);`,
};

function commandFile(name, site) {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const at = (name) => ${JSON.stringify(site)} + '/' + name;
const json = (name, fallback = {}) => (existsSync(at(name)) ? JSON.parse(readFileSync(at(name), 'utf8')) : fallback);
const faults = json('faults.json');
appendFileSync(at('calls.log'), JSON.stringify({ name: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + '\\n');
${COMMANDS[name]}
`;
}

/** The synthetic grant: one deploy destination for docs and tests changes, automatic rollback, a one-minute check window. */
function grantRecord(now, changes = {}) {
  return { schema: 'aiworks-release-authorization/1', project: PROJECT, version: 1,
    approval: 'https://github.com/example-org/sample-site/issues/1', grantedAt: isoDay(now - DAY), expiresAt: isoDay(now + 30 * DAY), revoked: false,
    destinations: [{ id: DESTINATION, environment: 'production', kind: 'deploy', changeClasses: ['docs', 'tests'], rollback: 'automatic', checkWindowMinutes: 1,
      commands: { deploy: 'ops/deploy.mjs', observe: 'ops/observe.mjs', check: 'ops/check.mjs', rollback: 'ops/rollback.mjs' } }],
    classes: { docs: ['docs/**', '*.md'], tests: ['tests/**'], 'app-code': ['ops/**', 'release/**'], migration: ['db/migrations/**'] },
    ...changes };
}

/**
 * Run the rehearsal. `root` is an empty directory to work in (a new one under the system temporary folder by default);
 * it is removed afterwards unless `keep`. Returns { passed, scenarios: [{ id, title, passed, evidence: [text] }] }.
 * Evidence text names only the synthetic project, destination and commit identities, never a local path.
 */
export async function rehearseRelease({ root = null, keep = false, now = Date.now() } = {}) {
  const dir = root ?? mkdtempSync(join(tmpdir(), 'aiworks-release-rehearsal-'));
  const repo = join(dir, 'project'), site = join(dir, 'site'), dataDir = join(dir, 'data'), dbPath = join(dataDir, 'supervisor.db');
  for (const path of [repo, site, dataDir]) mkdirSync(path, { recursive: true });
  let time = now;
  const clock = () => time;
  const sleep = async (ms) => { time += ms; };
  let store = new Store(dbPath);
  let lease = { instanceId: 'rehearsal-first', generation: store.acquireLease(CAMPAIGN, 'rehearsal-first', time, LEASE_MS).generation };
  const scenarios = [];

  // ---- the disposable project, its grant and the site it deploys to ----
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))), GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=AIWorks rehearsal', '-c', 'user.email=rehearsal@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: gitEnv, timeout: 60_000 });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed in the rehearsal repository: ${(result.stderr ?? '').trim().slice(0, 200)}`);
    return result.stdout.trim();
  };
  const write = (path, text) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), text); };
  const siteJson = (name, fallback = null) => (existsSync(join(site, name)) ? JSON.parse(readFileSync(join(site, name), 'utf8')) : fallback);
  const faults = (value) => writeFileSync(join(site, 'faults.json'), JSON.stringify(value));
  const calls = (name) => (existsSync(join(site, 'calls.log')) ? readFileSync(join(site, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
    .filter((call) => !name || call.name === name);
  const tree = (revision) => git('rev-parse', `${revision}^{tree}`);
  const short = (sha) => String(sha).slice(0, 12);

  git('init', '-q', '-b', 'main');
  for (const name of Object.keys(COMMANDS)) write(`ops/${name}.mjs`, commandFile(name, site.split('\\').join('/')));
  write(GRANT_PATH, `${JSON.stringify(grantRecord(now), null, 2)}\n`);
  write('docs/guide.md', 'The sample site guide.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'sample site with its release grant');
  const first = git('rev-parse', 'HEAD');
  mkdirSync(join(site, 'artifacts'));
  writeFileSync(join(site, 'artifacts', `${digestOf(first).slice(7)}.json`), JSON.stringify({ revision: first, digest: digestOf(first) }));
  writeFileSync(join(site, 'live.json'), JSON.stringify({ revision: first, digest: digestOf(first) }));
  faults({});
  // Grants that must refuse, each on its own ref: an expired one and a revoked one.
  for (const [ref, changes] of [['grant-expired', { grantedAt: isoDay(now - 40 * DAY), expiresAt: isoDay(now - 10 * DAY) }], ['grant-revoked', { version: 2, revoked: true }]]) {
    git('checkout', '-q', '-b', ref, 'main');
    write(GRANT_PATH, `${JSON.stringify(grantRecord(now, changes), null, 2)}\n`);
    git('commit', '-q', '-am', ref);
    git('checkout', '-q', 'main');
  }

  /** One verified task commit off main; `merge` lets the merge gate merge it and journal `merged`, as merge.mjs does. */
  let tasks = 0;
  function candidate(files, { merge = true } = {}) {
    const taskId = `T${++tasks}`, base = git('rev-parse', 'main');
    git('checkout', '-q', '-b', `task/${taskId}`, 'main');
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A'); git('commit', '-q', '-m', `task ${taskId}`);
    const verifiedSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    let mergeCommit = null;
    if (merge) {
      git('merge', '-q', '--no-ff', '-m', `merge gate: ${taskId}`, `task/${taskId}`);
      mergeCommit = git('rev-parse', 'HEAD');
      store.journal(CAMPAIGN, 'merged', { task: taskId, sha: verifiedSha, mergeCommit }, time);
    }
    return { project: PROJECT, destinationId: DESTINATION, taskId, verifiedSha, base, mergeCommit };
  }

  /** The evidence readers of one evaluation. `config`, `ref` and `path` choose the switch and the grant read. */
  function readers({ config = ENABLED, ref = 'main', path = GRANT_PATH } = {}) {
    const loaded = () => loadAuthorization({ repoPath: repo, ref, path, project: PROJECT, now: clock(), mergeGate: MERGE_GATE });
    const grant = () => { const l = loaded(); return l.valid ? { record: JSON.parse(l.bytes.toString('utf8')), digest: l.digest } : { reason: l.reasons[0] }; };
    return {
      config, grantNow: grant,
      switches: () => releaseSwitches({ dataDir, config, store, project: PROJECT, destination: DESTINATION, grant: grant() }),
      grant: () => { const l = loaded(); return l.bytes ? { bytes: l.bytes, commit: l.commit, ref: l.ref, path: l.path } : undefined; },
      mergeGate: () => MERGE_GATE,
      authority: () => ({ decisionAccepted: true, registryPointsHere: true }), // synthetic: the rehearsal's own registry
      verification: (c) => ({ taskState: 'done', verdict: 'accepted', targetSha: c.verifiedSha, verifySession: `verify-${c.taskId}`, implementSessions: [`implement-${c.taskId}`] }),
      merged: mergedEventReader(store, CAMPAIGN),
      current: (c) => {
        const baseHead = git('rev-parse', 'main');
        const onBase = c.mergeCommit ? spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', c.mergeCommit, baseHead], { windowsHide: true, env: gitEnv }).status === 0 : false;
        return { baseHead, mergeCommitOnBase: onBase };
      },
      diff: (c) => git('diff', '--name-status', '--no-renames', `${c.base}..${c.verifiedSha}`),
      checks: (c) => ({ sha: c.verifiedSha, required: [{ name: 'local-check', conclusion: 'success' }], preflight: true }),
      wayBack: () => ({ rollback: true, knownGood: Boolean(siteJson('live.json')?.digest) }),
      dependencies: () => ({ independent: true }),
      destinationState: () => {
        const held = destinationState(store, PROJECT, DESTINATION);
        const open = store.get("SELECT COUNT(*) AS n FROM releases WHERE project = ? AND destination = ? AND state IN ('unknown', 'rollback-failed')", PROJECT, DESTINATION);
        return { lockHeld: !held.free, unknownRelease: open.n > 0 };
      },
      ownerReserved: () => ({ reported: false }),
    };
  }

  const destinationRecord = grantRecord(now).destinations[0];
  const adapterFor = (config = ENABLED) => deployAdapter({ destination: destinationRecord, repo, config, dataDir, store, timeoutMs: 60_000, checkIntervalMs: 10_000, clock, sleep });
  const at = () => ({ lease, now: clock() });
  const gateFor = (read) => (r) => releaseGate({ dataDir, config: read.config, store, project: PROJECT, destination: DESTINATION, grant: read.grantNow() });
  const evaluate = (c, read = readers()) => evaluateEligibility(c, read, { now: clock() });
  const failedChecks = (result) => result.failed.map((item) => item.check);

  /** Plan a release of `c` and take the destination lock with a fresh re-check. Returns { eligibility, lock }. */
  function plan(c, read = readers(), recheck = read) {
    const eligibility = evaluate(c, read);
    if (!eligibility.eligible) return { eligibility, lock: null };
    const row = createRelease(store, { project: PROJECT, destination: DESTINATION, campaignId: CAMPAIGN, taskId: c.taskId, verifiedSha: c.verifiedSha,
      grantVersion: eligibility.inputs.grantVersion, grantDigest: eligibility.inputs.grantDigest, steps: ['deploy', 'check'], ...at() });
    return { eligibility, lock: acquireLock(store, row.id, { ...at(), recheck: () => evaluate(c, recheck) }) };
  }
  /** Run the next steps until the release settles, is stopped by a switch or becomes unknown. */
  async function drive(id, adapter = adapterFor(), read = readers()) {
    let r = release(store, id);
    while (nextStep(r)) {
      const after = await runStep(store, adapter, id, { ...at(), gate: gateFor(read) });
      if (after.history.length === r.history.length) return after; // a switch stopped it: nothing ran
      r = after;
    }
    return r;
  }

  async function scenario(id, title, body) {
    const evidence = [];
    let passed = true;
    const expect = (ok, text) => { evidence.push(`${ok ? 'yes' : 'NO'}: ${text}`); if (!ok) passed = false; };
    try { await body(expect); } catch (error) { expect(false, `the scenario stopped: ${String(error?.message ?? error).slice(0, 200)}`); }
    scenarios.push({ id, title, passed, evidence });
  }

  try {
    let accepted = null;
    await scenario('exact-release', 'A docs change is released at its exact merged revision and checked', async (expect) => {
      const c = candidate({ 'docs/guide.md': 'The sample site guide, revised.\n' });
      const { eligibility, lock } = plan(c);
      expect(eligibility.eligible, `eligible on positive evidence for all of E1 to E13 (failed: ${failedChecks(eligibility).join(', ') || 'none'})`);
      expect(lock?.locked === true, 'the destination lock was taken after a fresh re-check');
      const r = await drive(lock.release.id);
      accepted = r;
      expect(r.state === 'accepted', `the release is accepted (state ${r.state})`);
      expect(r.verified_sha === c.verifiedSha, `the release names verified revision ${short(c.verifiedSha)}`);
      expect(tree(c.mergeCommit) === tree(c.verifiedSha), `merge commit ${short(c.mergeCommit)} holds exactly the verified tree`);
      const deploys = calls('deploy');
      expect(deploys.length === 1 && deploys[0].args[0] === c.mergeCommit, 'deploy ran once, for the merge commit the merge gate recorded');
      const live = siteJson('live.json');
      expect(live.revision === c.mergeCommit && live.digest === r.deployed_digest, `the site runs ${short(c.mergeCommit)} with the digest the release recorded`);
      expect(r.previous_digest === digestOf(c.base), 'the previous digest is retained for a restore');
      expect(r.eligibility?.inputs?.destination?.rollback === 'automatic' && r.eligibility.inputs.grantSource?.path === GRANT_PATH,
        'the release row keeps its destination details and where its grant was read');
      expect(destinationState(store, PROJECT, DESTINATION).free, 'accepted frees the destination lock');
    });

    await scenario('check-now', 'Check the site now reports the destination’s health without releasing anything', async (expect) => {
      const id = accepted?.id;
      const runs = calls().length;
      const healthy = await checkReleaseNow({ store, dataDir, config: ENABLED, id, now: clock });
      expect(healthy.checked && healthy.outcome === 'passed', `a healthy site is reported passed (${healthy.outcome ?? healthy.reason})`);
      faults({ down: true });
      const down = await checkReleaseNow({ store, dataDir, config: ENABLED, id, now: clock });
      faults({});
      expect(down.checked && down.outcome === 'failed', `a broken site is reported failed (${down.outcome ?? down.reason})`);
      const newCalls = calls().slice(runs);
      expect(newCalls.length === 2 && newCalls.every((call) => call.name === 'check'), 'only the check command ran: nothing was deployed or rolled back');
      const after = release(store, id);
      expect(after.state === 'accepted' && after.health_check?.outcome === 'failed', 'the release keeps its state; the latest check is kept beside it');
      const off = await checkReleaseNow({ store, dataDir, config: { release: { enabled: false } }, id, now: clock });
      expect(!off.checked && /switched off/.test(off.reason), 'with release.enabled off the check is refused and nothing runs');
      expect(calls().length === runs + 2, 'the refused check ran no command');
    });

    await scenario('rollback', 'A release whose check fails is rolled back to the previous version, which is checked again', async (expect) => {
      const c = candidate({ 'docs/guide.md': 'A guide revision that breaks the site.\n' });
      faults({ failDigests: [digestOf(c.mergeCommit)] });
      const { lock } = plan(c);
      const r = await drive(lock.release.id);
      faults({});
      expect(r.state === 'rolled-back', `the release is rolled back (state ${r.state})`);
      expect(siteJson('live.json').digest === r.previous_digest && r.previous_digest === digestOf(c.base), 'the previous version is live again');
      expect(calls('rollback').length === 1 && calls('rollback')[0].args[0] === r.previous_digest, 'rollback ran once, to the retained previous digest');
      expect(destinationState(store, PROJECT, DESTINATION).free, 'a known rollback frees the destination lock');
    });

    await scenario('crash-recovery', 'A controller that dies mid-deploy is replaced; the new one reads the site and never deploys twice', async (expect) => {
      const c = candidate({ 'docs/guide.md': 'The guide, released across a crash.\n' });
      const { lock } = plan(c);
      const id = lock.release.id, adapter = adapterFor();
      let acted;
      const deployed = new Promise((done) => { acted = done; });
      // The deploy acts, then the controller dies before its outcome is recorded.
      runStep(store, { run: async (r, step) => { await adapter.run(r, step); acted(); return new Promise(() => {}); }, observe: adapter.observe }, id, { ...at(), gate: gateFor(readers()) });
      await deployed;
      expect(release(store, id).step_outcome === null, 'the deploy step is open: its outcome was never recorded');
      store.close();
      store = new Store(dbPath);
      time += LEASE_MS + 1;
      lease = { instanceId: 'rehearsal-second', generation: store.acquireLease(CAMPAIGN, 'rehearsal-second', time, LEASE_MS).generation };
      expect(markUnknownAfterRestart(store, CAMPAIGN, at()).includes(id), 'after the restart the open step is unknown');
      const settled = await reconcile(store, adapterFor(), id, at());
      expect(settled.state === 'deployed', `a read-only observe proves the deploy happened (state ${settled.state})`);
      const r = await drive(id);
      expect(r.state === 'accepted', `the release finishes its check and is accepted (state ${r.state})`);
      expect(calls('deploy').filter((call) => call.args[0] === c.mergeCommit).length === 1, 'deploy ran once for that revision');
    });

    await scenario('unknown-outcome', 'An outcome nobody can read stays unknown, keeps the destination and is never repeated', async (expect) => {
      const c = candidate({ 'docs/guide.md': 'The guide, with a site that cannot be read.\n' });
      faults({ observeUnreadable: [c.mergeCommit] });
      const { lock } = plan(c);
      const id = lock.release.id;
      const r = await drive(id);
      expect(r.state === 'unknown', `observe gave no answer after deploy, so the outcome is unknown, not success (state ${r.state})`);
      expect(destinationState(store, PROJECT, DESTINATION).releaseId === id, 'the unknown release keeps the destination lock');
      const next = evaluate(c);
      expect(failedChecks(next).includes('E11'), 'no other release may start on an unknown destination (E11)');
      const refusedCheck = await checkReleaseNow({ store, dataDir, config: ENABLED, id, now: clock });
      expect(!refusedCheck.checked, 'Check the site now is refused while the outcome is unknown');
      expect((await reconcile(store, adapterFor(), id, at())).state === 'unknown', 'a second unreadable look leaves it unknown');
      faults({});
      const settled = await reconcile(store, adapterFor(), id, at());
      expect(settled.state === 'deployed', 'once the site can be read, observe settles it from what is live');
      expect((await drive(id)).state === 'accepted', 'the release then finishes its check');
      expect(calls('deploy').filter((call) => call.args[0] === c.mergeCommit).length === 1, 'deploy was never repeated');
    });

    await scenario('refusals', 'Off, stopped, missing, expired, revoked or changed grants and unsafe changes are refused before anything runs', async (expect) => {
      const runs = calls().length;
      const c = candidate({ 'docs/guide.md': 'The guide, offered while releases are refused.\n' });
      const cases = [
        ['release.enabled off', readers({ config: { release: { enabled: false } } }), 'E1'],
        ['missing grant', readers({ path: 'release/absent.json' }), 'E2'],
        ['expired grant', readers({ ref: 'grant-expired' }), 'E2'],
        ['revoked grant', readers({ ref: 'grant-revoked' }), 'E2'],
      ];
      for (const [name, read, check] of cases) {
        const result = evaluate(c, read);
        expect(!result.eligible && failedChecks(result).includes(check), `${name}: not eligible (${check}: ${result.failed.find((item) => item.check === check)?.reason ?? 'passed'})`);
      }
      writeFileSync(join(dataDir, RELEASE_STOP), 'rehearsal');
      expect(failedChecks(evaluate(c)).includes('E1'), 'RELEASE-STOP: not eligible (E1)');
      unlinkSync(join(dataDir, RELEASE_STOP));
      // The grant is revoked between planning and the lock: the re-check refuses and the lock is never taken.
      const changed = plan(c, readers(), readers({ ref: 'grant-revoked' }));
      expect(changed.lock?.refused === true && changed.lock.release.state === 'refused', 'a grant revoked after planning refuses the release at the lock');
      const migration = candidate({ 'db/migrations/0001.sql': 'create table example (id integer);\n' }, { merge: false });
      const m = evaluate(migration);
      expect(failedChecks(m).includes('E7') && failedChecks(m).includes('E13'), 'a database migration is never released (E7, E13)');
      const unclassified = candidate({ 'notes.txt': 'a file no class covers\n' }, { merge: false });
      expect(failedChecks(evaluate(unclassified)).includes('E7'), 'a file no class covers blocks the release (E7)');
      expect(calls().length === runs, 'no project command ran for any refused release');
      expect(destinationState(store, PROJECT, DESTINATION).free, 'the destination stays free');
    });

    await scenario('stop-and-tree', 'A stop prevents the next step, and merged code that is not the checked code is never deployed', async (expect) => {
      const c = candidate({ 'docs/guide.md': 'The guide, released after a stop.\n' });
      const { lock } = plan(c);
      const id = lock.release.id, runs = calls().length;
      writeFileSync(join(dataDir, RELEASE_STOP), 'rehearsal');
      const stopped = await drive(id);
      expect(stopped.state === 'locked' && /RELEASE-STOP/.test(stopped.reason ?? '') && calls().length === runs, 'RELEASE-STOP stopped the release before its deploy; nothing ran');
      unlinkSync(join(dataDir, RELEASE_STOP));
      expect((await drive(id)).state === 'accepted', 'once the owner removes the stop, the same release continues');
      // The merge gate's event names a merge commit whose tree is not the verified tree.
      const t = candidate({ 'docs/guide.md': 'The checked guide.\n' }, { merge: false });
      git('merge', '-q', '--no-ff', '-m', `merge gate: ${t.taskId}`, `task/${t.taskId}`);
      write('docs/extra.md', 'A change nobody checked.\n');
      git('add', '-A'); git('commit', '-q', '-m', 'an unchecked change on main');
      const other = git('rev-parse', 'HEAD');
      store.journal(CAMPAIGN, 'merged', { task: t.taskId, sha: t.verifiedSha, mergeCommit: other }, time);
      const planned = plan({ ...t, mergeCommit: other });
      const before = calls().length;
      const r = planned.lock?.locked ? await drive(planned.lock.release.id) : planned.lock?.release;
      expect(r?.state === 'refused' && calls().length === before, 'a merge commit holding another tree is refused and runs no command');
    });

    await scenario('review-only', 'Narrowing the destination to Review only needs no grant and refuses every later release', async (expect) => {
      setReviewOnly(store, { project: PROJECT, destination: DESTINATION, grantVersion: 1, now: clock() });
      const c = candidate({ 'docs/guide.md': 'The guide, offered after narrowing.\n' });
      const result = evaluate(c);
      expect(failedChecks(result).includes('E1'), `Review only: not eligible (${result.failed[0]?.reason})`);
      const deploysByRevision = new Map();
      for (const call of calls('deploy')) deploysByRevision.set(call.args[0], (deploysByRevision.get(call.args[0]) ?? 0) + 1);
      expect([...deploysByRevision.values()].every((n) => n === 1), 'across the whole rehearsal no revision was deployed twice');
      expect(destinationState(store, PROJECT, DESTINATION).free, 'the rehearsal ends with the destination free');
    });
  } finally {
    try { store.close(); } catch { /* already closed */ }
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
  return { passed: scenarios.every((item) => item.passed), scenarios };
}

/** The rehearsal report as plain text, one line per expectation. */
export function rehearsalText(result) {
  const lines = [`Release rehearsal: ${result.passed ? 'passed' : 'FAILED'} (${result.scenarios.filter((item) => item.passed).length} of ${result.scenarios.length} scenarios)`];
  for (const item of result.scenarios) {
    lines.push('', `${item.passed ? 'PASS' : 'FAIL'} ${item.id}: ${item.title}`);
    for (const line of item.evidence) lines.push(`  ${line}`);
  }
  lines.push('', 'Synthetic: a disposable repository, grant, site folder and data directory; release.enabled was true only in memory.',
    'Not covered here: a real destination, the governance pointer to a real grant (E3) and the supervisor driving releases on its own (REL11).');
  return lines.join('\n');
}
