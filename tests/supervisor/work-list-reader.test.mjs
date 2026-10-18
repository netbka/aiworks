// LO L6 (docs/design/LOCAL_OPERATION.md section 9, slice SELF6): the scoped work-list reader of the self-hosted
// repository. Its scope is fixed at run start, identity comes first, it never writes, the research snapshot ships only
// the scope, and every other repository keeps today's prompts and readers byte-identical. A disposable store; no network
// and no GitHub call: the GitHub command given to the snapshot fails if it runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { selfHostingSettings } from '../../src/supervisor/self-hosting.mjs';
import { addComment, createItem } from '../../src/supervisor/work-list.mjs';
import { createWorkListReader, readerServer, workListRun } from '../../src/supervisor/work-list-reader.mjs';
import { buildPrompt, prepare, unavailableReason } from '../../src/supervisor/adapters/executors.mjs';
import { researchContext } from '../../src/supervisor/adapters/research-context.mjs';
import { declaration, SQLITE } from './helpers.mjs';

const NOW = 1_760_000_000_000;
const REPOSITORY = 'example-org/aiworks';
const LOCAL = selfHostingSettings({ selfHosting: { repository: REPOSITORY, trustedMain: 'local' } });
const skip = !SQLITE && 'node:sqlite requires Node >= 22.5';

/** A data directory whose store holds the tracking item #443, the task's item #437 and another task's item #438. */
function rig(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aiworks-work-list-reader-'));
  // The supervisor keeps its writer open while workers read, as it does in production.
  const store = new Store(join(dataDir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  for (const [number, title] of [[443, 'Tracking item'], [437, 'Task item'], [438, 'Another task item']]) {
    createItem(store, { number, kind: 'task', title, body: `${title} body`, authorKind: 'import', now: NOW });
  }
  addComment(store, { number: 437, idempotencyKey: 'note:1', body: 'Coordination note.', authorKind: 'supervisor', now: NOW });
  return { dataDir, store };
}
const digest = (dataDir) => ['supervisor.db', 'supervisor.db-wal'].map((name) => join(dataDir, name))
  .map((path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null));

test('the reader scope is fixed at run start, identity comes first, it never writes, and the snapshot ships only the scope (LO L6)', { skip }, (t) => {
  const { dataDir } = rig(t);
  const workList = workListRun({ selfHosting: LOCAL, dataDir, repository: 'Example-Org/AIWorks', trackingIssue: 443, issue: 437,
    references: ['AGENTS.md'], role: 'implementation' });
  assert.deepEqual(workList.scope, { items: [437, 443], inventory: false });
  const config = JSON.parse(readerServer(workList, { runId: randomUUID(), packetDigest: 'a'.repeat(64) }).args[1]);
  const read = createWorkListReader(config);
  // Changing the configuration after the run started widens nothing.
  config.scope.items.push(438);
  config.scope.inventory = true;
  const before = digest(dataDir);

  assert.throws(() => read({ resource: 'item', number: 437 }), /identity first/);
  assert.deepEqual(read({ resource: 'repository' }).data.scope, { items: [437, 443], inventory: false });
  assert.equal(read({ resource: 'item', number: 437 }).data.title, 'Task item');
  assert.deepEqual(read({ resource: 'comments', number: 437 }).data.map((c) => c.body), ['Coordination note.']);
  assert.throws(() => read({ resource: 'item', number: 438 }), /outside this run's scope/);
  assert.throws(() => read({ resource: 'comments', number: 438 }), /outside this run's scope/);
  assert.throws(() => read({ resource: 'items' }), /reviewer or planning/);
  assert.throws(() => read({ resource: 'item', number: 437, state: 'closed' }), 'the read tool takes no field that could change an item');
  assert.equal(read({ resource: 'item', number: 443 }).data.title, 'Tracking item', 'a refusal keeps the reader usable');
  assert.deepEqual(digest(dataDir), before, 'reading changed nothing in the store');

  // A store failure stops the reader: no retry, no other source.
  const broken = createWorkListReader(config, { open: () => { throw new Error('locked'); } });
  assert.throws(() => broken({ resource: 'repository' }), /could not be opened/);
  assert.throws(() => broken({ resource: 'repository' }), /stopped/);

  // The research snapshot reads the same scope from the store; the GitHub command would fail if it ran.
  const workspace = join(dataDir, 'checkout');
  mkdirSync(workspace);
  const decl = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report', references: [] }] });
  decl.target.repository = REPOSITORY;
  const snapshot = researchContext({ gh: [process.execPath, '-e', 'process.exit(97)'], git: null, workspace, declaration: decl,
    task: decl.tasks[0], now: NOW, revision: 'b'.repeat(40), workList });
  assert.match(snapshot, /Task item body/);
  assert.match(snapshot, /Coordination note\./);
  assert.doesNotMatch(snapshot, /Another task item/);
  assert.deepEqual(digest(dataDir), before, 'the snapshot changed nothing in the store');
});

test('other repositories keep prompts, packets and readers byte-identical; the self-hosted one gets no GitHub reader (LO L6)', { skip }, (t) => {
  const { dataDir } = rig(t);
  const runDir = join(dataDir, 'runs', 'op'), workspace = join(dataDir, 'checkout');
  mkdirSync(runDir, { recursive: true }); mkdirSync(workspace);
  const packet = { taskId: 'T1', goal: 'Produce the first artifact.', constraints: ['Read GitHub with REST only.'] };
  const prompt = (extra) => buildPrompt({ role: 'implementation', deliverable: 'commit', packet, packetDigest: 'c'.repeat(64), repository: REPOSITORY,
    issue: 437, branch: 'campaign/test/T1', baseSha: 'b'.repeat(40), ...extra });
  const launch = (executor, extra) => prepare({ executor, command: ['native-cli'], role: 'implementation', deliverable: 'commit',
    sessionId, digest: 'c'.repeat(64), runDir, workspace, prompt: 'task', repository: REPOSITORY,
    ghCommand: [process.execPath, 'gh.mjs'], ...extra });
  const sessionId = randomUUID();
  const codex = { kind: 'codex-cli', model: 'codex-model' };
  const claude = { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' };

  // Off, or any other repository: no work list, so every argument is today's.
  for (const [selfHosting, repository] of [[selfHostingSettings({}), REPOSITORY], [LOCAL, 'example-org/sampleapp']]) {
    assert.equal(workListRun({ selfHosting, dataDir, repository, trackingIssue: 443, issue: 437 }), null);
  }
  assert.equal(prompt({ workList: null }), prompt({}));
  for (const executor of [codex, claude]) {
    assert.deepEqual(launch(executor, { workList: null }), launch(executor, {}));
  }
  assert.equal(unavailableReason(codex, workspace, ['gh'], { workList: null }), 'unavailable: repository reader requires an absolute GitHub CLI command');

  // The self-hosted repository: the work-list reader replaces the GitHub reader, and the packet travels unchanged.
  const workList = workListRun({ selfHosting: LOCAL, dataDir, repository: REPOSITORY, trackingIssue: 443, issue: 437 });
  const packetBlock = (text) => text.slice(text.indexOf('```json'), text.indexOf('```', text.indexOf('```json') + 7));
  const listed = prompt({ workList });
  assert.equal(packetBlock(listed), packetBlock(prompt({})));
  assert.doesNotMatch(listed, /gh issue view/);
  for (const executor of [codex, claude]) {
    const argv = launch(executor, { workList }).argv.join('\n');
    assert.match(argv, /aiworks_worklist/);
    assert.doesNotMatch(argv, /github-reader\.mjs|aiworks_repository/);
  }
  assert.notEqual(unavailableReason(codex, workspace, ['gh'], { workList }), 'unavailable: repository reader requires an absolute GitHub CLI command');
});
