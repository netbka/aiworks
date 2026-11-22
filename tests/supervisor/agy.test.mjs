// The AGY browser worker for web acceptance tasks: declaration rules, routing, per-run isolation, result
// classification and one synthetic end-to-end run. No model, browser, network or GitHub access.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BROWSER_SERVER, BUILD_RETRY_NOTE, CODE_PERMISSION_MODE, DENY, RUN_COMMAND_LIMIT, TOOLS, deniedCommand, webScope } from '../../src/supervisor/adapters/agy.mjs';
import { validResult } from '../../src/supervisor/adapters/claude.mjs';
import { passedCheck } from '../../src/supervisor/result-review.mjs';
import { agyCodeRoles, buildPrompt, classify, prepare, roleUnavailableReason, unavailableReason, webFlag } from '../../src/supervisor/adapters/executors.mjs';
import { replay, route } from '../../src/supervisor/router.mjs';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, GOVERNANCE, runUntil, skipWithoutSqlite } from './helpers.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const agy = { kind: 'agy-cli', model: 'gemini-3.1-pro-high' };
const claudeProvider = { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' };
const web = { urls: ['http://127.0.0.1:6006/?path=/story/checkout', 'http://127.0.0.1:6006/iframe.html'], resourceOrigins: ['https://fonts.gstatic.com'] };
const webTask = { id: 'W1', issue: 439, title: 'checkout view acceptance', deliverable: 'report', goal: 'Accept the checkout view.',
  dependsOn: [], acceptance: ['A1 the total equals the sum of the items'], references: ['AGENTS.md'], web };
const chain = (...providers) => ({ kind: 'cli-chain', providers, implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 });
const digest = 'a'.repeat(64);
const expect = { deliverable: 'report', sessionId: 'bound-run', packetDigest: digest, web: true };
const terminal = { result: 'resolved', summary: 'ACCEPTED', report: '**Visual acceptance: ACCEPTED**' };

const events = ({ result = { runId: 'bound-run', packetDigest: digest, result: terminal }, status = 'SUCCESS', tools = [], extra = {}, mode = 'request-review' } = {}) => [
  { event: 'init', conversation_id: 'c1', init: { permission_mode: mode } },
  ...tools.map((step, index) => ({ event: 'step_update', step_update: { step_index: index + 1, step_type: 'tool', ...step } })),
  { event: 'result', result: { conversation_id: 'c1', status, structured_output: result, usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 30 }, ...extra } },
].map((event) => JSON.stringify(event)).join('\n');
const run = (stdoutText, options = {}) => classify({ executorKind: 'agy-cli', role: 'implementer', run: { exitCode: 0 }, stdoutText, stderrText: '', expect, now: 1000, ...options });
const browserTool = (state, ToolName = 'navigate_page') => ({ state, tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: BROWSER_SERVER, ToolName } } });
/** A Chrome install layout: chrome.exe beside its version-named folder. */
function fakeChrome(t, version) {
  const dir = mkdtempSync(join(tmpdir(), 'aiworks-chrome-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'chrome.exe'), '');
  if (version) mkdirSync(join(dir, version));
  return [join(dir, 'chrome.exe')];
}

test('web acceptance tasks are reports reviewed by the declared agy browser worker only', () => {
  const d = declaration({ tasks: [declaration().tasks[0], webTask] });
  d.executor = chain(claudeProvider, agy);
  assert.equal(validateDeclaration(structuredClone(d)).tasks[1].web.urls.length, 2);
  const invalid = (change, pattern) => { const copy = structuredClone(d); change(copy); assert.throws(() => validateDeclaration(copy), pattern); };
  invalid((c) => { c.tasks[1].deliverable = 'commit'; }, /web requires deliverable report/);
  invalid((c) => { c.executor = chain({ kind: 'codex-cli' }, { kind: 'cursor-cli' }); }, /needs a browser worker/);
  invalid((c) => { c.executor = chain({ ...claudeProvider, researchOnly: true }); }, /needs a browser worker/);
  assert.equal(validateDeclaration({ ...structuredClone(d), executor: chain(claudeProvider) }).executor.providers[0].kind, 'claude-cli',
    'Claude with the isolated browser may run web tasks on its own');
  invalid((c) => { delete c.executor.providers[1].model; }, /executor.model required/);
  invalid((c) => { c.executor.providers[1].researchOnly = true; }, /researchOnly does not apply/);
  invalid((c) => { c.executor.providers[1].permissionMode = 'auto'; }, /permissionMode applies only/);
  for (const url of ['ftp://host/', ['http://user', 'secret@127.0.0.1/'].join(':'), 'http://127.0.0.1/*', 'not a url', 'javascript:alert(1)']) {
    invalid((c) => { c.tasks[1].web.urls = [url]; }, /web.urls/);
  }
  invalid((c) => { c.tasks[1].web.urls = []; }, /web.urls/);
  invalid((c) => { c.tasks[1].web.resourceOrigins = ['https://fonts.gstatic.com/s/']; }, /resourceOrigins/);
  invalid((c) => { c.tasks[1].web.extra = true; }, /web must be/);
  for (const url of ['http://127.0.0.1:4318/', 'http://localhost:17321/mcp', 'http://[::1]:4318/', 'http://dash.localhost:4318/',
    'http://localhost.:4318/', 'http://foo.localhost.:17321/', 'http://[::ffff:127.0.0.1]:4318/', 'https://example.org:4318/']) {
    invalid((c) => { c.tasks[1].web.urls = [url]; }, /must not name port 4318 .* or 17321 .* on any host/);
  }
  invalid((c) => { c.tasks[1].web.resourceOrigins = ['http://127.0.0.1:4318']; }, /must not name port 4318/);
  const publicSite = structuredClone(d);
  publicSite.tasks[1].web = { urls: ['https://example.org/pricing'] };
  assert.equal(validateDeclaration(publicSite).tasks[1].web.urls[0], 'https://example.org/pricing', 'any declared public site is allowed');
  assert.equal(validateDeclaration({ ...structuredClone(d), executor: chain(agy) }).executor.providers[0].kind, 'agy-cli',
    'an all-agy declaration registers: without agy.codeRoles its code task waits as unavailable at run time');
  const webOnly = structuredClone(d);
  webOnly.tasks = [webTask];
  webOnly.executor = { ...agy, implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  assert.equal(validateDeclaration(webOnly).executor.kind, 'agy-cli', 'a campaign of web tasks may use AGY alone');
  // A fourth provider fits beside the Claude, Codex and Cursor chain.
  const four = structuredClone(d);
  four.executor = chain(claudeProvider, { kind: 'codex-cli' }, { kind: 'cursor-cli' }, agy);
  assert.equal(validateDeclaration(four).executor.providers.length, 4);
});

test('only the browser workers run web tasks, and agy runs nothing else', (t) => {
  for (const role of ['implementer', 'verification']) {
    assert.equal(roleUnavailableReason(agy, role, 'report', 'win32', true), null);
    assert.match(roleUnavailableReason(agy, role, 'report', 'win32', false), /only web acceptance/);
    assert.equal(roleUnavailableReason(claudeProvider, role, 'report', 'win32', true), null, 'Claude browses with the isolated browser');
    assert.match(roleUnavailableReason({ ...claudeProvider, researchOnly: true }, role, 'report', 'win32', true), /browser worker/);
    for (const kind of ['codex-cli', 'cursor-cli']) assert.match(roleUnavailableReason({ kind }, role, 'report', 'win32', true), /browser worker/);
  }
  assert.match(unavailableReason(agy, '.', null, { web: true }), /commands.chrome/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: ['chrome.exe'], web: true }), /absolute/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: [join(tmpdir(), 'no-such-chrome.exe')], web: true }), /does not exist/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: fakeChrome(t, null), web: true }), /Chrome 149 or newer .*found no version/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: fakeChrome(t, '148.0.7000.10'), web: true }), /Chrome 149 or newer .*found 148/);
  assert.equal(unavailableReason(agy, '.', null, { chromeCommand: fakeChrome(t, '155.0.8059.39'), web: true }), null);
});

test('each agy run gets its own profile home, explicit denies and a browser locked to the declared origins', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'aiworks-agy-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  assert.throws(() => prepare({ executor: agy, command: ['agy'], role: 'implementer', deliverable: 'commit', runDir, prompt: 'p', web }), /web acceptance task/);
  const invocation = prepare({ executor: agy, command: ['C:/agy/agy.exe'], role: 'implementer', deliverable: 'report', sessionId: 'bound-run', digest,
    runDir, workspace: 'unused-checkout', prompt: 'review this', web, chromeCommand: ['C:/Chrome/chrome.exe'], timeoutMs: 30 * 60_000 });
  const home = join(runDir, 'agy-home');
  const temp = join(runDir, 'agy-tmp');
  const { AGY_CLI_DISABLE_AUTO_UPDATE: update, ...folders } = invocation.env;
  assert.equal(update, '1', 'the audited CLI does not change under a campaign');
  assert.deepEqual(folders, { USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: temp, TMP: temp, TMPDIR: temp }, 'every per-user folder is run-local');
  assert.ok(Object.values(folders).every((path) => path.startsWith(runDir)));
  assert.equal(invocation.cwd, join(runDir, 'agy-scratch'), 'no repository checkout is reachable');
  const argv = invocation.argv;
  for (const [flag, value] of [['--input-format', 'stream-json'], ['--output-format', 'stream-json'], ['--model', agy.model], ['--print-timeout', '1800s']]) {
    assert.equal(argv[argv.indexOf(flag) + 1], value);
  }
  assert.ok(argv.includes('--disable-slash-commands') && argv.at(-1) === '-p=');
  assert.ok(!argv.some((arg) => /dangerously|always-proceed/.test(arg)), 'never skips permissions');
  const message = JSON.parse(invocation.prompt);
  assert.equal(message.event, 'user');
  assert.ok(message.message.content.startsWith('review this\n'));
  assert.ok(message.message.content.includes(`runId "bound-run", packetDigest "${digest}"`), 'the binding values are spelled out');
  assert.equal(invocation.prompt.trim().split('\n').length, 1, 'one turn, then stdin closes');
  for (const folder of ['Local', 'Roaming']) assert.ok(existsSync(join(home, 'AppData', folder)), 'known folders resolve inside the run-local home');
  const settings = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.equal(settings.toolPermission, 'request-review');
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.deepEqual(settings.permissions.deny, DENY);
  for (const rule of ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'unsandboxed(*)']) assert.ok(settings.permissions.deny.includes(rule));
  assert.deepEqual(settings.permissions.allow, [`mcp(${BROWSER_SERVER}/*)`, 'execute_url(127.0.0.1)']);
  const servers = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), [BROWSER_SERVER], 'the browser is the only MCP server');
  assert.match(servers[BROWSER_SERVER].args[0], /browser-mcp\.mjs$/);
  const browser = JSON.parse(readFileSync(servers[BROWSER_SERVER].args[1], 'utf8'));
  assert.deepEqual(browser.allowedUrlPatterns, ['http://127.0.0.1:6006/*', 'https://fonts.gstatic.com/*']);
  assert.equal(browser.chrome, 'C:/Chrome/chrome.exe');
  assert.ok(browser.profileDir.startsWith(runDir), 'a fresh Chrome profile inside the run directory');
  for (const key of ['filesDir', 'tempDir']) assert.ok(browser[key].startsWith(runDir), `${key} is run-local (the browser file tools' roots)`);
  assert.deepEqual(Object.keys(browser).sort(), ['allowedUrlPatterns', 'chrome', 'filesDir', 'profileDir', 'tempDir'], 'no real profile home reaches the browser');
  const schema = JSON.parse(readFileSync(argv[argv.indexOf('--json-schema') + 1], 'utf8'));
  assert.equal(schema.properties.runId.const, 'bound-run');
  assert.equal(schema.properties.packetDigest.const, digest);
  assert.deepEqual(webScope({ urls: ['https://a.example/x', 'https://a.example/y?z=1'] }), { hosts: ['a.example'], patterns: ['https://a.example/*'] });
});

test('agy results bind the run and packet, and any tool outside the browser voids them without fallback', () => {
  const ok = run(events({ tools: [browserTool('DONE'),
    { state: 'ERROR', tool_name: 'run_command', tool_info: { error: { message: 'permission check failed for command "dir": Permission denied' } } },
    { state: 'ERROR', tool_name: 'finish', tool_info: { error: { message: "invalid arguments: at '/runId'" } } }, { state: 'DONE', tool_name: 'finish' }] }));
  assert.equal(ok.class, 'result', 'a denied shell call never ran');
  assert.equal(ok.receipt.sessionId, 'bound-run');
  assert.equal(ok.receipt.nativeSessionId, 'c1');
  assert.deepEqual(ok.receipt.usage, { input: 10, output: 2, cacheRead: 30, cacheCreation: null, reasoning: null, total: null });
  for (const tool_name of ['search_web', 'send_message', 'define_subagent', 'open_browser_url']) {
    const voided = run(events({ tools: [browserTool('DONE'), { state: 'DONE', tool_name }] }));
    assert.equal(voided.class, 'error');
    assert.match(voided.detail, new RegExp(`unexpected tool \\(${tool_name}\\); held for the owner, no provider fallback`));
    assert.equal(voided.violation, true, 'a boundary violation holds the task for the owner');
  }
  assert.equal(run(events({ tools: [{ state: 'DONE', tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'other' } } }] })).class, 'error');
  assert.equal(run(events({ tools: [{ state: 'ERROR', tool_name: 'send_message', tool_info: { error: { message: 'delivery failed' } } }] })).class, 'error',
    'a failed tool that may have run is still unexpected');
  assert.match(run(events({ extra: { denied_actions: [{ action: 'read_file' }] } })).detail, /needs approval/);
  assert.match(run(events({ mode: 'always-proceed' })).detail, /permission mode/);
  assert.equal(run(events({ result: { runId: 'stale', packetDigest: digest, result: terminal } })).class, 'invalid-result');
  assert.equal(run(events({ result: { runId: 'bound-run', packetDigest: digest, result: terminal, extra: 1 } })).class, 'invalid-result');
  assert.equal(run(events({ result: { runId: 'bound-run', packetDigest: digest, result: { ...terminal, report: '' } } })).class, 'invalid-result');
  assert.equal(run(events({ result: null })).class, 'exit-without-result', 'a print timeout ends SUCCESS without output');
  assert.equal(run(events().split('\n').slice(0, -1).join('\n')).class, 'exit-without-result');
  const failed = (error, stderrText = '') => run(events({ status: 'ERROR', extra: { error }, result: null }), { run: { exitCode: 1 }, stderrText });
  assert.equal(failed('RESOURCE_EXHAUSTED: quota exceeded').class, 'quota');
  assert.equal(failed('authentication required').class, 'auth');
  assert.equal(failed('invalid model selection').class, 'error');
  assert.equal(run('', { run: { spawnError: 'ENOENT' } }).class, 'spawn-failed');
  assert.equal(run('', { run: { timedOut: true } }).class, 'timeout');
});

test('the audit fails closed on event shapes and browser tools it does not know', () => {
  const lines = (...items) => items.map((item) => JSON.stringify(item)).join('\n');
  const init = { event: 'init', init: { permission_mode: 'request-review' } };
  const result = { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', structured_output: { runId: 'bound-run', packetDigest: digest, result: terminal } } };
  const step = (fields) => ({ event: 'step_update', step_update: { step_index: 7, ...fields } });
  assert.equal(run(lines(init, result)).class, 'result');
  assert.match(run(lines(result)).detail, /no init event/, 'no init, no accepted result');
  assert.match(run(lines(init, init, result)).detail, /request-review/, 'two sessions in one stream');
  assert.match(run(lines(init, step({ step_type: 'subagent_call', state: 'DONE' }), result)).detail, /unexpected tool \(step subagent_call\)/);
  assert.match(run(lines(init, step({ step_type: 'tool', state: 'ACTIVE', tool_name: 'send_message' }), result)).detail, /send_message/,
    'a disallowed tool that started counts even without a terminal update');
  assert.equal(run(lines(init, step({ step_type: 'tool', state: 'ACTIVE', ...browserTool('ACTIVE') }),
    step({ step_type: 'tool', state: 'DONE', tool_name: 'call_mcp_tool' }), result)).class, 'result', 'parameters carry over to the terminal update');
  for (const name of ['upload_file', 'take_heapsnapshot', 'get_heapsnapshot_summary', 'open_devtools', 'install_extension']) {
    assert.match(run(events({ tools: [browserTool('DONE', name)] })).detail, new RegExp(`browser/${name}`));
  }
  assert.equal(run(events({ tools: [{ ...browserTool('ERROR', 'upload_file'), tool_info: { parameters: { ServerName: BROWSER_SERVER, ToolName: 'upload_file' },
    error: { message: 'permission check failed for mcp "browser/upload_file": Permission denied' } } }] })).class, 'result', 'a denied call never ran');
  assert.equal(run(events({ tools: [{ state: 'ERROR', tool_name: 'send_message', tool_info: { error: { message: 'delivery failed: Unknown argument for tool x' } } }] })).class,
    'error', 'not-run is matched at the start of the error only');
  const failed = (stderrText) => run(events({ status: 'ERROR', extra: { error: 'agy exited' }, result: null }), { run: { exitCode: 1 }, stderrText });
  assert.equal(failed('page log: wrote 429 bytes').class, 'error', 'a bare 429 is not a quota');
  assert.equal(failed('page text: quota exceeded, please wait').class, 'error', 'only agy\'s own error lines count');
  assert.equal(failed('error: HTTP 429 from the model backend').class, 'quota');
  assert.equal(failed('error: authentication required').class, 'auth');
  // Every update counts: a tool that ran, a renamed step, a violation hidden behind a timeout, an unreadable line.
  const forbidden = { step_type: 'tool', tool_name: 'send_message' };
  assert.equal(run(lines(init, step({ ...forbidden, state: 'ACTIVE' }), step({ ...forbidden, state: 'ERROR',
    tool_info: { error: { message: 'permission check failed for send_message: Permission denied' } } }), result)).class, 'result',
  'the normal denial shape (ACTIVE, then a not-run ERROR) never ran');
  assert.equal(run(lines(init, step({ ...forbidden, state: 'DONE' }), step({ ...forbidden, state: 'ERROR',
    tool_info: { error: { message: 'permission check failed for x' } } }), result)).violation, true, 'a step that reached DONE ran');
  assert.equal(run(lines(init, step({ ...forbidden, state: 'ACTIVE' }), step({ step_type: 'tool', state: 'DONE', ...browserTool('DONE') }), result)).violation, true,
    'a later update cannot rename a forbidden step');
  const timedOut = run(lines(init, step({ ...forbidden, state: 'DONE' })), { run: { timedOut: true } });
  assert.equal(timedOut.violation, true, 'a violation is not hidden behind a timeout');
  const unreadable = run(lines(init, result) + '\n{"event":"step_update",');
  assert.match(unreadable.detail, /unreadable line, so the run cannot be fully audited/);
  assert.equal(unreadable.violation, true, 'what an unreadable line hides might have been a violation');
  const oversized = run(lines(init, result), { logBytes: 65 * 1024 * 1024 });
  assert.match(oversized.detail, /over the 67108864-byte audit limit/);
  assert.equal(oversized.violation, true);
  assert.equal(run(lines(init, result) + '\n{"event":"step_update",', { run: { exitCode: 1 }, stderrText: 'error: quota exceeded' }).class, 'error',
    'an unreadable log is never a quota wait');
});

test('a browser verification that truthfully confirms a failing criterion is valid, yet never counts as passed', () => {
  // A truthful REJECTED report: its claim «criterion 1 fails» holds (check pass), the criterion itself fails. The browser
  // verification is valid, the repository one is not, and the result never counts as passed.
  const digestOfR = createHash('sha256').update('r', 'utf8').digest('hex');
  const truthful = { verdict: 'accepted', targetSha: 'b'.repeat(40), reportDigest: digestOfR, summary: 'The report is true.', findings: [],
    checks: [{ command: 'C1 layout', result: 'pass' }], criteria: [{ criterion: 1, result: 'fail', check: 'Opened the page', evidence: 'It overflows, as reported.' }] };
  const expect = { deliverable: 'report', targetSha: 'b'.repeat(40), reportDigest: digestOfR };
  assert.equal(validResult('verification', truthful, { ...expect, web: true }), null);
  assert.notEqual(validResult('verification', truthful, expect), null, 'a repository verification may not accept a failed criterion');
  assert.equal(passedCheck({ verification: truthful, verified_sha: 'b'.repeat(40), result: { report: 'r' } }, ['C1']), false, 'a page failing its criterion never passes');
  const holds = { ...truthful, criteria: [{ ...truthful.criteria[0], result: 'pass' }] };
  assert.equal(passedCheck({ verification: holds, verified_sha: 'b'.repeat(40), result: { report: 'r' } }, ['C1']), true, 'and one meeting it does');
});
test('a web build task is never routed to agy, to implement or to verify', () => {
  const build = webFlag({ urls: ['https://dev.example.invalid/'], mode: 'build' });
  for (const stage of ['implement', 'verify']) {
    const decision = route({ stage, chain: true, task: { deliverable: 'report', web: build }, platform: 'win32',
      candidates: [{ kind: 'agy-cli', model: agy.model }, { kind: 'claude-cli', model: 'opus' }],
      hostFacts: ['agy-cli', 'claude-cli'].map((kind) => ({ kind, cliConfigured: true, hostUnavailable: false, wait: null })),
      escalation: { priorAttempts: [] } });
    assert.equal(decision.chosen.kind, 'claude-cli', stage);
    const alone = route({ stage, chain: false, task: { deliverable: 'report', web: build }, platform: 'win32',
      candidates: [{ kind: 'agy-cli', model: agy.model }], hostFacts: [{ kind: 'agy-cli', cliConfigured: true, hostUnavailable: false, wait: null }],
      escalation: { priorAttempts: [] } });
    assert.equal(alone.chosen, null, `${stage}: agy alone never takes a build task`);
  }
});

test('an accepted build verification needs every criterion passed', () => {
  const report = 'r';
  const reportDigest = createHash('sha256').update(report, 'utf8').digest('hex');
  const expect = { deliverable: 'report', targetSha: 'b'.repeat(40), reportDigest, acceptance: 2 };
  const criterion = (n, result) => ({ criterion: n, result, check: 'Opened the page', evidence: 'Seen.' });
  const accepted = (criteria) => ({ verdict: 'accepted', targetSha: 'b'.repeat(40), reportDigest, summary: 'Done.', findings: [],
    checks: [{ command: 'change 1', result: 'pass' }], criteria });
  for (const criteria of [[criterion(1, 'pass'), criterion(2, 'fail')], [criterion(1, 'pass')], [criterion(1, 'pass'), criterion(2, 'not-checked')]]) {
    assert.ok(validResult('verification', accepted(criteria), { ...expect, web: 'build' }), JSON.stringify(criteria));
  }
  const full = accepted([criterion(1, 'pass'), criterion(2, 'pass')]);
  assert.equal(validResult('verification', full, { ...expect, web: 'build' }), null);
  assert.equal(passedCheck({ verification: full, verified_sha: 'b'.repeat(40), result: { report } }, ['C1', 'C2']), true, 'its report is released');
});

// Refused: with agy.codeRoles on, an agy extension folder above every checkout refuses the code task's AGY run. That task
// alone moves on, once and without a wait on AGY, so the web task still runs on AGY.
for (const refused of [false, true]) test(`a campaign routes its web task to agy for acceptance and verification, and its code task elsewhere${refused ? ' (checkout refused for AGY code mode)' : ''}`, { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const env = environment();
  const agyState = join(env.tmp, 'agy');
  mkdirSync(agyState);
  if (refused) mkdirSync(join(env.tmp, '.agents'));
  process.env.FAKE_AGY_STATE = agyState;
  const config = { ...env.config, ...(refused ? { agy: { codeRoles: true } } : {}),
    commands: { ...env.config.commands, agy: [process.execPath, FAKE_AGY], chrome: fakeChrome(t, '155.0.8059.39') } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report' }, { ...webTask, dependsOn: ['T1'] }] });
  d.executor = chain(agy, claudeProvider);
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); delete process.env.FAKE_AGY_STATE; });
  await runUntil(controller, store, d.campaignId, (c) => c.control === 'finished');
  const ops = store.all('SELECT task_id, kind, executor_kind, run_dir, outcome, routing FROM operations WHERE campaign_id = ? ORDER BY created_at', d.campaignId);
  assert.deepEqual(ops.map((op) => `${op.task_id}.${op.kind}:${op.executor_kind}`),
    ['T1.implement:claude-cli', 'T1.verify:claude-cli', 'W1.implement:agy-cli', 'W1.verify:agy-cli']);
  assert.ok(ops.every((op) => op.outcome.class === 'result'));
  if (refused) {
    assert.equal(store.all("SELECT seq FROM journal WHERE campaign_id = ? AND kind = 'agy-code-refused'", d.campaignId).length, 1, 'AGY is never picked again for that task');
    assert.ok(ops[0].routing.inputs.hostFacts.find((fact) => fact.kind === 'agy-cli').hostUnavailable, 'the receipt records the refusal');
    assert.deepEqual(replay(ops[0].routing), ops[0].routing.decision, 'and replays to the same choice');
  }
  const calls = readFileSync(join(agyState, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.role), ['implement', 'verify']);
  for (const [index, call] of calls.entries()) {
    const runDir = ops[2 + index].run_dir;
    assert.equal(call.home, join(runDir, 'agy-home'), 'agy saw only its run-local profile home');
    assert.equal(call.cwd, join(runDir, 'agy-scratch'));
    assert.deepEqual(call.settings.permissions.deny, DENY);
    assert.deepEqual(Object.keys(call.mcp.mcpServers), [BROWSER_SERVER]);
  }
  assert.equal(env.calls().length, 2, 'Claude ran only the code task');
  const posted = env.comments().filter((comment) => comment.issue === '439');
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.includes('**Visual acceptance: ACCEPTED**'));
  assert.equal(store.task(d.campaignId, 'W1').state, 'done');
});

for (const mode of ['violation', 'long-violation']) test(`a boundary violation ends the web task as not done instead of retrying it (${mode})`, { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const env = environment();
  const agyState = join(env.tmp, 'agy');
  mkdirSync(agyState);
  Object.assign(process.env, { FAKE_AGY_STATE: agyState, FAKE_AGY_MODE: mode });
  const config = { ...env.config, commands: { ...env.config.commands, agy: [process.execPath, FAKE_AGY], chrome: fakeChrome(t, '155.0.8059.39') } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [webTask] });
  d.executor = { ...agy, implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 };
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); delete process.env.FAKE_AGY_STATE; delete process.env.FAKE_AGY_MODE; });
  await runUntil(controller, store, d.campaignId, () => store.task(d.campaignId, 'W1').state === 'cancelled');
  for (let tick = 0; tick < 5; tick++) await controller.tick();
  const task = store.task(d.campaignId, 'W1');
  assert.match(task.last_error, /^not done: boundary violation on agy-cli: browser worker used an unexpected tool \(search_web\)/);
  assert.equal(store.all('SELECT id FROM operations WHERE campaign_id = ?', d.campaignId).length, 1, 'no retry on the same provider');
  assert.equal(readFileSync(join(agyState, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(env.comments().filter((comment) => comment.issue === '439').length, 0, 'nothing is published');
  // The controller's own read path: an early violation in a log longer than its 4 MiB default tail is still found.
  const { run_dir: runDir } = store.get('SELECT run_dir FROM operations WHERE campaign_id = ?', d.campaignId);
  if (mode === 'long-violation') assert.ok(statSync(join(runDir, 'stdout.json')).size > 4 * 1024 * 1024, 'the log exceeds 4 MiB');
});

test('Claude on a web task gets the same browser and nothing else', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'aiworks-claude-web-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  for (const role of ['implementer', 'verification']) {
    const invocation = prepare({ executor: claudeProvider, command: ['claude.exe'], role, deliverable: 'report', sessionId: 'bound-run', digest,
      runDir, workspace: 'unused-checkout', prompt: 'review this', web, chromeCommand: ['C:/Chrome/chrome.exe'], timeoutMs: 60_000 });
    const argv = invocation.argv;
    const after = (flag) => argv[argv.indexOf(flag) + 1];
    assert.equal(after('--tools'), '', 'no built-in tool: no shell, files, web search or subagents');
    assert.equal(after('--permission-mode'), 'dontAsk', 'anything not listed is denied without a prompt, whatever the declared mode');
    for (const flag of ['--setting-sources', '--strict-mcp-config']) assert.ok(argv.includes(flag));
    const servers = JSON.parse(after('--mcp-config')).mcpServers;
    assert.deepEqual(Object.keys(servers), [BROWSER_SERVER], 'the run-local browser is the only MCP server');
    assert.ok(JSON.parse(readFileSync(servers[BROWSER_SERVER].args[1], 'utf8')).allowedUrlPatterns.includes('http://127.0.0.1:6006/*'));
    const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
    assert.deepEqual(allowed, TOOLS.map((name) => `mcp__${BROWSER_SERVER}__${name}`));
    assert.deepEqual(argv.slice(argv.indexOf('--disallowedTools') + 1), [`mcp__${BROWSER_SERVER}__upload_file`]);
    assert.ok(!argv.some((arg) => /^Bash|^Read|^Write|^Edit|bypassPermissions/.test(arg)));
    assert.equal(invocation.cwd, join(runDir, 'web-scratch'), 'no repository checkout');
    assert.equal(JSON.parse(after('--json-schema')).required.includes(role === 'verification' ? 'verdict' : 'result'), true);
  }
  assert.throws(() => prepare({ executor: { ...claudeProvider, researchOnly: true }, command: ['claude.exe'], role: 'implementer', deliverable: 'report',
    sessionId: 'bound-run', digest, runDir, prompt: 'p', web, chromeCommand: ['C:/Chrome/chrome.exe'] }), /browses only/);
  assert.match(buildPrompt({ executorKind: 'claude-cli', web, role: 'implementer', deliverable: 'report', packet: { taskId: 'W1' }, packetDigest: digest,
    repository: 'example-org/sampleapp' }), /VISUAL ACCEPTANCE/, 'a web task gets the browser prompt on Claude too');
});

test('when AGY is not available, Claude takes the web task with the isolated browser', { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const env = environment({ scenario: { implement: ['report'] } });
  // AGY has no command on this PC (out of credits or not installed): the chain does not wait for it.
  const config = { ...env.config, commands: { ...env.config.commands, chrome: fakeChrome(t, '155.0.8059.39') } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [webTask] });
  d.executor = chain(agy, claudeProvider);
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); });
  await runUntil(controller, store, d.campaignId, (c) => c.control === 'finished');
  const ops = store.all('SELECT kind, executor_kind FROM operations WHERE campaign_id = ? ORDER BY created_at', d.campaignId);
  assert.deepEqual(ops.map((op) => `${op.kind}:${op.executor_kind}`), ['implement:claude-cli', 'verify:claude-cli']);
  for (const call of env.calls()) {
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert.deepEqual(Object.keys(JSON.parse(call.args[call.args.indexOf('--mcp-config') + 1]).mcpServers), [BROWSER_SERVER]);
  }
  assert.equal(env.comments().filter((comment) => comment.issue === '439').length, 1, 'the verified report is posted');
});

/** A build campaign on a synthetic DEV origin, with a governance copy whose sampleapp entry lists `origins`. */
async function buildCampaign(t, { scenario = {}, origins }) {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'aiworks-build-gov-'));
  const governanceRoot = join(scratch, 'governance');
  cpSync(GOVERNANCE, governanceRoot, { recursive: true });
  const entry = join(governanceRoot, 'registry', 'projects', 'sampleapp.json');
  const list = (value) => writeFileSync(entry, JSON.stringify({ ...JSON.parse(readFileSync(entry, 'utf8')), web: { buildOrigins: value } }, null, 2));
  list(origins);
  const env = environment({ scenario, config: { governanceRoot } });
  const config = { ...env.config, commands: { ...env.config.commands, chrome: fakeChrome(t, '155.0.8059.39') } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [{ ...webTask, goal: 'Add the synthetic field on the DEV server.', web: { urls: ['https://dev.example.invalid/app'], mode: 'build' } }] });
  d.executor = chain(agy, claudeProvider);
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); rmSync(scratch, { recursive: true, force: true }); });
  return { store, controller, d, env, list };
}

test('a build retry and a build repair inspect the pages first and never redo a change', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, d } = await buildCampaign(t, { origins: ['https://dev.example.invalid'],
    scenario: { implement: ['no-result', 'report', 'report'], verify: ['reject', 'accept-report-criterion'] } });
  await runUntil(controller, store, d.campaignId, (c) => c.control === 'finished');
  const prompts = store.all("SELECT kind, executor_kind, run_dir FROM operations WHERE campaign_id = ? AND kind = 'implement' ORDER BY created_at", d.campaignId)
    .map((op) => { assert.equal(op.executor_kind, 'claude-cli'); return readFileSync(join(op.run_dir, 'prompt.txt'), 'utf8'); });
  assert.equal(prompts.length, 3);
  assert.ok(prompts[1].includes(BUILD_RETRY_NOTE), 'the retry after a run without a result is told the pages may already be changed');
  assert.ok(prompts[2].includes('fix on the pages what each blocking finding names, never redo a change that is already there'));
  for (const prompt of prompts.slice(1)) assert.doesNotMatch(prompt, /nothing from that attempt is retained|report-only and read-only/);
  assert.equal(store.task(d.campaignId, 'W1').state, 'done', 'an accepted build report with its criterion passed completes');
});

test('an origin removed from the registry stops new build runs', { skip: skipWithoutSqlite }, async (t) => {
  const { store, controller, d, list } = await buildCampaign(t, { origins: ['https://dev.example.invalid'] });
  list(['https://other.example.invalid']);
  await runUntil(controller, store, d.campaignId, (c) => Boolean(c.blocker));
  for (let tick = 0; tick < 3; tick++) await controller.tick();
  assert.equal(store.campaign(d.campaignId).blocker.code, 'WEB_BUILD_ORIGIN_NOT_ALLOWED');
  assert.equal(store.all('SELECT id FROM operations WHERE campaign_id = ?', d.campaignId).length, 0, 'no worker was dispatched');
});

test('agy code mode takes only report tasks, only under agy.codeRoles, in a sandbox it cannot leave', (t) => {
  for (const role of ['implementer', 'verification']) {
    for (const deliverable of ['commit', 'report']) {
      assert.ok(roleUnavailableReason(agy, role, deliverable, 'win32', false), 'off by default');
      assert.ok(roleUnavailableReason(agy, role, deliverable, 'win32', false, { agyCodeRoles: false }));
    }
    assert.equal(roleUnavailableReason(agy, role, 'report', 'win32', false, { agyCodeRoles: true }), null);
    assert.ok(roleUnavailableReason(agy, role, 'commit', 'win32', false, { agyCodeRoles: true }), 'a commit would have to leave the sandbox');
  }
  assert.ok(roleUnavailableReason(agy, 'implementer', 'report', 'win32', 'build', { agyCodeRoles: true }), 'a build task stays Claude-only');
  assert.deepEqual([{ agy: { codeRoles: true } }, { agy: { codeRoles: 'true' } }, { agy: {} }, {}, null].map(agyCodeRoles), [true, false, false, false, false]);
  const inputs = (deliverable, extra = {}) => ({ stage: 'implement', chain: true, task: { deliverable, web: false }, platform: 'win32',
    candidates: [{ kind: 'agy-cli', model: agy.model }, { kind: 'claude-cli', model: 'opus' }],
    hostFacts: ['agy-cli', 'claude-cli'].map((kind) => ({ kind, cliConfigured: true, hostUnavailable: false, wait: null })),
    escalation: { priorAttempts: [] }, ...extra });
  assert.equal(route(inputs('report')).chosen.kind, 'claude-cli');
  assert.equal(route(inputs('report', { agyCodeRoles: 'yes' })).chosen.kind, 'claude-cli', 'only the exact true counts');
  assert.equal(route(inputs('report', { agyCodeRoles: true })).chosen.kind, 'agy-cli');
  assert.equal(route(inputs('commit', { agyCodeRoles: true })).chosen.kind, 'claude-cli');
  // A checkout refused for this task (agy-cli's recorded host fact) moves the task to the next provider.
  assert.equal(route(inputs('report', { agyCodeRoles: true, hostFacts: [{ kind: 'agy-cli', cliConfigured: true, hostUnavailable: 'refused', wait: null },
    { kind: 'claude-cli', cliConfigured: true, hostUnavailable: false, wait: null }] })).chosen.kind, 'claude-cli');
  const runDir = mkdtempSync(join(tmpdir(), 'aiworks-agy-code-'));
  const above = mkdtempSync(join(tmpdir(), 'aiworks-agy-tree-'));
  const workspace = join(above, 'checkout');
  mkdirSync(workspace);
  // A linked worktree: its .git is a file, and the main checkout's folders above it still count.
  writeFileSync(join(workspace, '.git'), 'gitdir: ../main/.git/worktrees/checkout\n');
  t.after(() => { rmSync(runDir, { recursive: true, force: true }); rmSync(above, { recursive: true, force: true }); });
  const launch = (deliverable) => prepare({ executor: agy, command: ['agy'], role: 'verification', deliverable, sessionId: 'bound-run', digest, runDir, workspace, prompt: 'p', timeoutMs: 60_000 });
  assert.throws(() => launch('commit'));
  const invocation = launch('report');
  assert.equal(invocation.cwd, workspace);
  assert.ok(invocation.argv.includes('--sandbox'));
  assert.equal(invocation.env.AGY_CLI_DISABLE_AUTO_UPDATE, '1');
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'agy-home', '.gemini', 'config', 'mcp_config.json'), 'utf8')), { mcpServers: {} });
  const settings = JSON.parse(readFileSync(join(runDir, 'agy-home', '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.equal(settings.toolPermission, CODE_PERMISSION_MODE, 'a sandboxed command runs; leaving the sandbox needs an approval print mode refuses');
  assert.ok(!settings.permissions.allow.some((rule) => rule.startsWith('command(')), 'a command allow rule would also approve leaving the sandbox');
  for (const rule of ['write_file(*)', 'mcp(*)', 'read_url(*)']) assert.ok(settings.permissions.deny.includes(rule));
  assert.equal(unavailableReason(agy, workspace, null, {}), null, 'code mode needs no browser');
  // agy loads project hooks, which run outside the sandbox and the audit, from any of four folders, even above the checkout.
  for (const name of ['.agents', '.agent', '_agents', '_agent']) {
    for (const dir of [workspace, above]) {
      mkdirSync(join(dir, name));
      assert.ok(unavailableReason(agy, workspace, null, {}), join(dir, name));
      rmSync(join(dir, name), { recursive: true });
    }
  }
  assert.equal(unavailableReason(agy, workspace, null, {}), null);
});

test('the code-mode audit voids denied commands, writes, MCP calls, unknown tools and a sandbox bypass', () => {
  const code = { ...expect, web: false };
  const systemMessage = JSON.stringify({ event: 'step_update', step_update: { step_index: 0, step_type: 'system_message', state: 'DONE' } });
  const read = (tools, { mode = CODE_PERMISSION_MODE, extra = {} } = {}) => {
    const lines = events({ tools, mode, extra }).split('\n');
    return run([lines[0], systemMessage, ...lines.slice(1)].join('\n'), { expect: code });
  };
  const shell = (CommandLine) => ({ state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine } } });
  const allowed = [{ state: 'DONE', tool_name: 'read_file', tool_info: { parameters: { Path: 'app.js' } } }, shell('git status --short'),
    shell('git log --grep=push --oneline'), shell('grep -rn "git push" docs'), { state: 'DONE', tool_name: 'manage_task', tool_info: { parameters: { Action: 'status' } } },
    ...['rg -c alias. src', 'wc -c alias.txt', 'grep -rn GIT_CONFIG_COUNT src', 'gh auth status', 'echo cmd a b c d e f g & dir /k',
      'rg -l cmd src tests docs scripts site lib bin | findstr /c:"spawn"', 'rg -n "powershell" a b c d e f g h i j k l m | rg -e Encoded',
      'rg -n "git push" cmd/cli', 'grep -rn "git commit" src/cmd/client.go', 'cat cmd/kubectl/main.go | grep "gh pr merge"',
      'rg "gh auth token" internal/cmd/config'].map(shell)];
  assert.equal(read(allowed).class, 'result');
  const voided = [
    ...['git push origin HEAD', 'git -C . push', 'cmd /c "git push origin x"', 'git status; git commit -am x', '& "git" push', 'gh pr create --fill',
      'gh workflow run ci', 'npm run deploy', 'ssh host', 'powershell -EncodedCommand ZQB=', 'git -c core.sshCommand="ssh -v" push',
      'git -c alias.p=push p origin main', 'bash -lc "git push origin x"', 'git subtree push --prefix=docs origin pages', 'git send-pack origin main',
      'gh gist create notes.md', 'git config alias.p push', 'GIT_CONFIG_COUNT=1 git p', 'gh auth token', 'gh auth status --show-token', 'gh auth status ""-t',
      'git "push"', 'git --attr-source HEAD push', 'npx vercel --prod', 'pnpm dlx netlify-cli deploy', 'yarn dlx npm publish',
      'npx "netlify-cli" deploy --prod', 'pnpm dlx "netlify" deploy', 'npx "npm@10" publish', 'pnpm --silent dlx vercel',
      String.raw`C:\Windows\System32\cmd.exe /c "git push origin x"`, String.raw`"C:\Program Files\Git\bin\bash.exe" -c "git push origin x"`,
      '/usr/bin/bash -c "git push origin x"', 'cmd/c "git push origin x"', 'gh "auth" token', "gh 'pr' merge 1",
      // Git's config variables set in ways no assignment pattern lists, on a line that runs git.
      ...[String.raw`Set-Item -Path Env:\GIT_CONFIG_COUNT -Value 1; Set-Item -Path Env:\GIT_CONFIG_KEY_0 -Value alias.x; Set-Item -Path Env:\GIT_CONFIG_VALUE_0 -Value push; git x origin main`,
        'GIT_CONFIG_COUNT+=1 GIT_CONFIG_KEY_0+=alias.x GIT_CONFIG_VALUE_0=push git x origin main',
        'printf -v GIT_CONFIG_COUNT 1; printf -v GIT_CONFIG_KEY_0 alias.x; export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0=push; git x origin main']
        .flatMap((line) => [line, `powershell -Command "${line}"`, `bash -c '${line}'`]),
      "$n='GIT_CONFIG_COUNT'; [Environment]::SetEnvironmentVariable($n,'1'); git x",
      // PowerShell runs a bare quoted argument as a command.
      'powershell "git push origin x"', `$n='GIT_CONFIG_COUNT'; [Environment]::SetEnvironmentVariable($n,'1'); powershell "git x origin main"`,
      // Past what the audit reads: the 33rd Git option, a cmd switch beyond the window, a line over 64 KiB.
      `git ${'-c a=b '.repeat(33)}push`, 'cmd /d /e:on /v:off /q /a /u /t:0 /c "git push"', `git status ${'a'.repeat(64 * 1024)}`,
      // A separator inside a substitution, a group or backticks, or a continued line, does not end the wrapper's command.
      ...['$(true;)', '`true;`', '$(:|:)'].map((part) => `bash ${'-x '.repeat(13)}${part} -c "git push origin x"`),
      'cmd /d /e:on /v:off /q /a /u /t:0 (x;) /c "git push origin x"', `powershell ${'-NoProfile '.repeat(13)}$(1;2) -EncodedCommand ZQB=`,
      `powershell ${'-NoProfile '.repeat(13)}\`\r\n-EncodedCommand ZQB=`].map(shell),
    { state: 'DONE', tool_name: 'run_command', tool_info: { parameters: {} } },
    { state: 'DONE', tool_name: 'write_file' }, { state: 'DONE', tool_name: 'search_web' }, browserTool('DONE'),
    { state: 'DONE', tool_name: 'manage_task', tool_info: { parameters: { Action: 'send_input' } } },
  ];
  for (const step of voided) assert.equal(read([step]).violation, true, JSON.stringify(step));
  // One run's audit reads a bounded amount of distinct command text; past it a command line is denied unread.
  const many = Array.from({ length: Math.ceil(RUN_COMMAND_LIMIT / (60 * 1024)) + 1 }, (_, index) => shell(`git status ${index} ${'a'.repeat(60 * 1024)}`));
  assert.equal(read(many).violation, true, 'command text past the run limit');
  // The worker writes the command line and the supervisor reads it: a line built to make a pattern backtrack is still read
  // at once (with nested option patterns, 25 Git options took seconds, and each one more doubled it), and so is a line
  // just under the size limit that holds a command name at every word.
  const started = performance.now();
  assert.equal(deniedCommand(`git ${'--x=y '.repeat(25)}status`), null);
  for (const unit of ['-a=git ', 'cmd /x ', 'bash -x ']) deniedCommand(unit.repeat(Math.floor((64 * 1024 - 1) / unit.length)));
  assert.ok(performance.now() - started < 1000, 'the audit cannot stall the supervisor');
  assert.equal(read(allowed, { mode: 'request-review' }).violation, true, 'only the sandboxed permission mode');
  assert.equal(read(allowed, { extra: { denied_actions: [{ action: 'command' }] } }).violation, true, 'a refused bypass voids the run');
});

test('an adaptive-planning stage reaches agy code mode: PLAN keeps its amendment, ACCEPT its uncovered items', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'aiworks-agy-stage-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const schema = (stage) => {
    prepare({ executor: agy, command: ['agy'], role: 'implementer', deliverable: 'report', sessionId: 'bound-run', digest, runDir, workspace: runDir, prompt: 'p', timeoutMs: 60_000, stage });
    return JSON.parse(readFileSync(join(runDir, 'output-schema.json'), 'utf8')).properties.result.properties;
  };
  assert.ok(schema('plan').amendment && schema('accept').uncovered);
  assert.ok(!schema(null).amendment);
  const code = { ...expect, web: false };
  const staged = (stage, extra) => classify({ executorKind: 'agy-cli', role: 'implementer', run: { exitCode: 0 }, stderrText: '', now: 1000, expect: code, stage,
    stdoutText: events({ mode: CODE_PERMISSION_MODE, result: { runId: 'bound-run', packetDigest: digest, result: { ...terminal, ...extra } } }) });
  const amendment = { basis: 'e'.repeat(64), ops: [{ op: 'cancel', taskId: 'T9', reason: 'synthetic' }] };
  assert.deepEqual(staged('plan', { amendment }).value.amendment, amendment);
  assert.deepEqual(staged('accept', { uncovered: ['A2'] }).value.uncovered, ['A2']);
  assert.equal(staged('plan', { amendment: { ...amendment, basis: 'not-a-digest' } }).class, 'invalid-result');
});
