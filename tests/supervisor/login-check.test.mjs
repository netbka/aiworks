// A sign-in check that misreads a reply would hold every campaign on the account, or release one a real run found
// signed out: only a definite answer may act, and a signed-in answer ends only the check's own wait.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/supervisor/store.mjs';
import { accountWait, setAccountWait } from '../../src/supervisor/accounts.mjs';
import { LOGIN_CHECK_MS, LOGIN_REASON, loginCheckPass } from '../../src/supervisor/login-check.mjs';

test('the sign-in check acts only on a definite answer and ends only its own wait', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-login-'));
  const store = new Store(join(dir, 'supervisor.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let clock = 1_000_000;
  const replies = [];
  const run = async (argv) => replies.shift()(argv);
  const ctl = { store, now: () => clock, config: { loginCheck: true, commands: { claude: ['claude'] } } };
  const step = async (reply) => { replies.push(reply); await loginCheckPass(ctl, { run }); clock += LOGIN_CHECK_MS; };

  await step(() => ({ code: null, out: '' }));
  await step(() => ({ code: 1, out: 'unexpected failure' }));
  assert.equal(accountWait(store, ctl.config, 'claude-cli'), null, 'a time-out or an unreadable reply records nothing');

  await step(() => ({ code: 1, out: JSON.stringify({ loggedIn: false }) }));
  assert.deepEqual([accountWait(store, ctl.config, 'claude-cli')?.retry_at, accountWait(store, ctl.config, 'claude-cli')?.reason], [null, LOGIN_REASON]);
  await step(() => ({ code: 0, out: JSON.stringify({ loggedIn: true }) }));
  assert.equal(accountWait(store, ctl.config, 'claude-cli'), null, 'signed in again ends the check\'s own wait');

  setAccountWait(store, ctl.config, { kind: 'claude-cli', retryAt: null, reason: 'auth: 401 from a real run', campaignId: 'c', now: clock });
  await step(() => ({ code: 0, out: JSON.stringify({ loggedIn: true }) }));
  assert.equal(accountWait(store, ctl.config, 'claude-cli')?.reason, 'auth: 401 from a real run', 'a wait a real run recorded is kept');

  replies.push(() => { throw new Error('must not run'); });
  await loginCheckPass({ ...ctl, config: { commands: { claude: ['claude'] } } }, { run });
  assert.equal(replies.length, 1, 'off unless loginCheck is true');
});
