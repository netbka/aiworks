// OWNER_UI_V2 WP8: product knowledge. Only the owner's own act makes a fact confirmed; a confirmed or edited suggestion
// keeps where it came from; a project never sees, or acts on, another project's facts, plans or suggestions; a stale or
// repeated change saves nothing twice. Synthetic store, fictional projects, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { planSuggestions, projectEvidence, projectKnowledge, saveFact, suggestionKey } from '../../src/supervisor/knowledge.mjs';

function plan(store, project, requestId, included) {
  const now = Date.now();
  store.run("INSERT INTO work_requests (request_id, project_id, route, plan_only, state, received_at, updated_at) VALUES (?, ?, 'goal', 0, 'drafted', ?, ?)",
    requestId, project, now, now);
  store.run(`INSERT INTO work_drafts (request_id, version, project_id, plan_only, state, declaration, scope_digest, authority_digest, pinned, summary, plan,
    steps, questions, conflicts, notes, outline, created_at, updated_at) VALUES (?, 1, ?, 0, 'ready', ?, 'sha256:x', 'sha256:y', '{}', 's', 'p', '[]', '[]', '[]', '[]', ?, ?, ?)`,
  requestId, project, JSON.stringify({ envelope: { outcome: 'Notes can be searched', acceptance: [] } }),
  JSON.stringify({ horizon: 'now', priority: 'normal', checks: [], included, later: [], estimate: null }), now, now);
}

test('only the owner confirms a fact, its origin survives edits, and no project reaches another project’s knowledge', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-knowledge-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  plan(store, 'lp-notes', 'req-notes-1', ['People can search their notes by title.']);
  plan(store, 'lp-ledger', 'req-ledger-1', ['Invoices are exported every night.']);

  // Each project's plans suggest only its own facts, marked as suggested by AI with the plan they came from.
  const notes = planSuggestions(store, 'lp-notes'), ledger = planSuggestions(store, 'lp-ledger');
  assert.deepEqual(notes.map((item) => [item.source, item.text, item.origin.requestId]), [['ai', 'People can search their notes by title.', 'req-notes-1']]);
  assert.deepEqual(ledger.map((item) => item.text), ['Invoices are exported every night.']);
  const view = projectKnowledge(store, 'lp-notes', notes);
  assert.deepEqual([view.facts.length, view.suggestions.length], [0, 1], 'a suggestion is never stored as a fact by itself');

  // Another project's suggestion cannot be confirmed here, even by its exact key.
  const foreign = suggestionKey('lp-ledger', ledger[0]);
  assert.throws(() => saveFact(store, { project: 'lp-notes', action: 'confirm', suggestion: foreign, version: 0, requestId: 'request-a1' }, { suggestions: notes }),
    { code: 'FACT_SUGGESTION_GONE' });

  const key = view.suggestions[0].key;
  saveFact(store, { project: 'lp-notes', action: 'confirm', suggestion: key, version: 0, requestId: 'request-a2' }, { suggestions: notes });
  saveFact(store, { project: 'lp-notes', action: 'edit', fact: key, version: 1, text: 'People can search notes by title or body.', requestId: 'request-a3' }, { suggestions: notes });
  // A repeat answers with what it saved; a stale page and a reused request id save nothing.
  assert.equal(saveFact(store, { project: 'lp-notes', action: 'edit', fact: key, version: 1, text: 'People can search notes by title or body.', requestId: 'request-a3' }).duplicate, true);
  assert.throws(() => saveFact(store, { project: 'lp-notes', action: 'edit', fact: key, version: 1, text: 'Older words', requestId: 'request-a4' }), { code: 'FACT_CHANGED' });
  assert.throws(() => saveFact(store, { project: 'lp-notes', action: 'edit', fact: key, version: 2, text: 'Other words', requestId: 'request-a3' }), { code: 'FACT_REQUEST_REUSED' });

  const after = projectKnowledge(store, 'lp-notes', notes);
  assert.equal(after.suggestions.length, 0, 'an acted-on suggestion is not suggested again');
  const [fact] = after.facts;
  assert.deepEqual([fact.text, fact.version, fact.edited, fact.basis.source, fact.basis.origin.requestId, fact.history.map((entry) => entry.act)],
    ['People can search notes by title or body.', 2, true, 'ai', 'req-notes-1', ['confirmed', 'edited']]);
  // The other project shows none of it, and cannot change it.
  assert.deepEqual(projectKnowledge(store, 'lp-ledger', ledger).facts, []);
  assert.throws(() => saveFact(store, { project: 'lp-ledger', action: 'retire', fact: key, version: 2, requestId: 'request-b1' }), { code: 'FACT_NOT_FOUND' });
  // A fact that looks like a credential is never kept.
  assert.throws(() => saveFact(store, { project: 'lp-notes', action: 'add', version: 0, text: 'API_KEY=sk-live-0123456789abcdef', requestId: 'request-a5' }), { code: 'FACT_SECRET' });
});

test('Knowledge names what approved goals record without reading a file, and never names a secret-like or outside path', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-evidence-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const token = `ghp_${'a'.repeat(36)}`, now = Date.now();
  const declaration = { version: 1, campaignId: 'notes-search', purpose: 'Notes can be searched', target: { repository: 'example-org/notes', trackingIssue: 1 },
    tasks: [{ id: 'search', outcome: 'Search by title', acceptance: ['A title search finds the note.', `Uses ${token}`],
      references: ['docs/brief.md#scope', 'docs/brief.md', '.env.local', 'deploy/credentials.json', 'certs/server.pem', '../outside.md', 'C:/elsewhere/notes.md'] }] };
  store.insert('campaigns', { id: 'notes-search', controller_id: 'aiworks-supervisor/notes-search', scope_digest: 'a'.repeat(64), authorization_version: 1,
    declaration, control: 'registered', status: 'active', next_action: 'x', next_wakeup_at: null, blocker: null, version: 1, created_at: now, updated_at: now });

  const evidence = projectEvidence(store, ['notes-search']);
  // The approved plan's criteria, with their origin; a credential-looking one is left out, never shown.
  assert.deepEqual(evidence.requirements.map((item) => [item.campaignId, item.authorizationVersion, item.criteria]), [['notes-search', 1, ['A title search finds the note.']]]);
  // Plain project paths by name only; secret-like, parent and absolute names are counted, never listed.
  assert.deepEqual(evidence.references.map((item) => item.reference), ['docs/brief.md#scope', 'docs/brief.md']);
  assert.equal(evidence.withheldReferences, 5);
  assert.ok(!JSON.stringify(evidence).includes(token) && !JSON.stringify(evidence).includes('.env'));
});
