// A new campaign may target only a registered portfolio project; stored campaigns are unaffected.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { declaration, GOVERNANCE, ROOT, runCli, runtimeCheckout, SQLITE } from './helpers.mjs';
import { assertRegisteredTarget } from '../../src/supervisor/campaign.mjs';
import { campaignStart } from '../../src/supervisor/api.mjs';
const Store = SQLITE ? (await import('../../src/supervisor/store.mjs')).Store : null;

const REGISTRY = GOVERNANCE;
const unregistered = () => {
  const decl = declaration({ campaignId: 'unregistered-target' });
  decl.target = { ...decl.target, projectId: 'nowhere', repository: 'netbka/not-a-registered-project' };
  return decl;
};

test('registered targets pass, case-insensitively; unregistered targets are refused', () => {
  assert.doesNotThrow(() => assertRegisteredTarget(declaration(), REGISTRY));
  const upper = declaration();
  upper.target = { ...upper.target, repository: 'NETBKA/dyk' };
  assert.doesNotThrow(() => assertRegisteredTarget(upper, REGISTRY));
  assert.throws(() => assertRegisteredTarget(unregistered(), REGISTRY), /not a registered project/);
});

test('the check reads only the given governance root registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-registry-'));
  try {
    mkdirSync(join(dir, 'registry', 'projects'), { recursive: true });
    writeFileSync(join(dir, 'registry', 'projects', 'one.json'), JSON.stringify({ id: 'one', repository: { github: 'owner/one' } }));
    writeFileSync(join(dir, 'registry', 'projects', 'notes.txt'), 'ignored');
    const decl = declaration();
    decl.target = { ...decl.target, repository: 'owner/one' };
    assert.doesNotThrow(() => assertRegisteredTarget(decl, dir));
    assert.throws(() => assertRegisteredTarget(declaration(), dir), /netbka\/Dyk is not a registered project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every committed campaign declaration targets a registered project', () => {
  const dir = join(ROOT, 'campaigns');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
    const decl = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert.doesNotThrow(() => assertRegisteredTarget(decl, REGISTRY), `${name} targets an unregistered repository`);
  }
});

test('CLI start refuses a new unregistered target but still resumes a stored campaign', { skip: !SQLITE }, () => {
  const root = mkdtempSync(join(tmpdir(), 'aiworks-campaign-registry-'));
  // The declaration is merged to main in a runtime checkout (AW-005), so only the registry gate can refuse it.
  const decl = unregistered();
  const runtime = runtimeCheckout({ declarations: { 'unregistered-target.json': decl } });
  const start = (dataDir, file) => runCli(runtime.cli, ['start', file, '--data', dataDir, '--governance', GOVERNANCE]);
  try {
    const file = join(runtime.root, 'campaigns', 'unregistered-target.json');

    const refusedData = join(root, 'refused');
    mkdirSync(refusedData);
    const refused = start(refusedData, file);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not a registered project/);
    const empty = new Store(join(refusedData, 'supervisor.db'));
    try { assert.ok(!empty.campaign(decl.campaignId), 'a refused registration stores nothing'); } finally { empty.close(); }

    // A campaign stored before the rule (or before its project left the registry) keeps resuming.
    const storedData = join(root, 'stored');
    const store = new Store(join(storedData, 'supervisor.db'));
    try { campaignStart(store, decl); } finally { store.close(); }
    const resumed = start(storedData, file);
    assert.equal(resumed.status, 0, resumed.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    runtime.cleanup();
  }
});
