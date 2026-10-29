// The AGY browser worker for web acceptance tasks: declaration rules, routing, per-run isolation, result
// classification and one synthetic end-to-end run. No model, browser, network or GitHub access.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BROWSER_SERVER, DENY, TOOLS, WEB_CRITERIA_RULE, webScope } from '../../src/supervisor/adapters/agy.mjs';
import { CRITERIA_RULE, validResult } from '../../src/supervisor/adapters/claude.mjs';
import { buildPrompt, classify, prepare, roleUnavailableReason, unavailableReason } from '../../src/supervisor/adapters/executors.mjs';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { declaration, environment, runUntil, skipWithoutSqlite } from './helpers.mjs';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const agy = { kind: 'agy-cli', model: 'gemini-3.1-pro-high' };
const claudeProvider = { kind: 'claude-cli', model: 'opus', permissionMode: 'auto' };
const web = { urls: ['http://127.0.0.1:6006/?path=/story/checkout', 'http://127.0.0.1:6006/iframe.html'], resourceOrigins: ['https://fonts.gstatic.com'] };
const webTask = { id: 'W1', issue: 439, title: 'checkout view acceptance', deliverable: 'report', goal: 'Accept the checkout view.',
  dependsOn: [], acceptance: ['A1 the total equals the sum of the items'], references: ['AGENTS.md'], web };
const chain = (...providers) => ({ kind: 'cli-chain', providers, implementerTimeoutMinutes: 1, verifierTimeoutMinutes: 1 });
const digest = 'a'.repeat(64);
const expect = { deliverable: 'report', sessionId: 'bound-run', packetDigest: digest };
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
  invalid((c) => { c.executor = chain(agy); }, /task without web needs an executor other than agy-cli/);
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
  assert.match(unavailableReason(agy, '.', null, {}), /commands.chrome/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: ['chrome.exe'] }), /absolute/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: [join(tmpdir(), 'no-such-chrome.exe')] }), /does not exist/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: fakeChrome(t, null) }), /Chrome 149 or newer .*found no version/);
  assert.match(unavailableReason(agy, '.', null, { chromeCommand: fakeChrome(t, '148.0.7000.10') }), /Chrome 149 or newer .*found 148/);
  assert.equal(unavailableReason(agy, '.', null, { chromeCommand: fakeChrome(t, '155.0.8059.39') }), null);
});

test('each agy run gets its own profile home, explicit denies and a browser locked to the declared origins', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'aiworks-agy-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  assert.throws(() => prepare({ executor: agy, command: ['agy'], role: 'implementer', deliverable: 'report', runDir, prompt: 'p' }), /web acceptance task/);
  const invocation = prepare({ executor: agy, command: ['C:/agy/agy.exe'], role: 'implementer', deliverable: 'report', sessionId: 'bound-run', digest,
    runDir, workspace: 'unused-checkout', prompt: 'review this', web, chromeCommand: ['C:/Chrome/chrome.exe'], timeoutMs: 30 * 60_000 });
  const home = join(runDir, 'agy-home');
  const temp = join(runDir, 'agy-tmp');
  assert.deepEqual(invocation.env, { USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: temp, TMP: temp, TMPDIR: temp }, 'every per-user folder is run-local');
  assert.ok(Object.values(invocation.env).every((path) => path.startsWith(runDir)));
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
  assert.equal(ok.receipt.costUsd, null, 'unreported cost stays unknown');
  assert.deepEqual(ok.receipt.usage, { input: 10, output: 2, cacheRead: 30, cacheCreation: null });
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

test('the browser prompt names the pages and the browser-only rules; the verifier re-checks every claim', () => {
  const packet = { taskId: 'W1', governance: { project: 'sampleapp', policies: [] } };
  const implement = buildPrompt({ executorKind: 'agy-cli', web, role: 'implementer', deliverable: 'report', packet, packetDigest: digest, repository: 'example-org/sampleapp' });
  for (const url of web.urls) assert.ok(implement.includes(`- ${url}`));
  assert.match(implement, /VISUAL ACCEPTANCE/);
  assert.match(implement, /Visual acceptance: ACCEPTED/);
  assert.match(implement, /emulate/);
  assert.doesNotMatch(implement, /read AGENTS\.md/, 'no repository instructions for a browser-only run');
  const verify = buildPrompt({ executorKind: 'agy-cli', web, role: 'verification', deliverable: 'report', packet, packetDigest: digest,
    repository: 'example-org/sampleapp', targetSha: 'b'.repeat(40), report: '**Visual acceptance: ACCEPTED**', reportDigest: 'c'.repeat(64) });
  assert.match(verify, /INDEPENDENT VERIFIER/);
  assert.match(verify, /re-check EVERY criterion/);
  assert.ok(verify.includes(WEB_CRITERIA_RULE), 'a browser verification returns one criteria entry per acceptance criterion, or its report is never released');
  assert.ok(!verify.includes(CRITERIA_RULE), 'a truthful REJECTED report is accepted, so the repository «failed criterion» rule does not apply');
  // A truthful REJECTED report: the claim «criterion 1 fails» is true, so its criteria entry passes and the result is valid.
  const truthful = { verdict: 'accepted', targetSha: 'b'.repeat(40), reportDigest: 'c'.repeat(64), summary: 'The report is true.', findings: [],
    checks: [{ command: 'C1 layout', result: 'pass' }], criteria: [{ criterion: 1, result: 'pass', check: 'Opened the page', evidence: 'It overflows, as reported.' }] };
  assert.equal(validResult('verification', truthful, { deliverable: 'report', targetSha: 'b'.repeat(40), reportDigest: 'c'.repeat(64) }), null);
  assert.ok(verify.includes(`targetSha ${'b'.repeat(40)} and reportDigest ${'c'.repeat(64)}`));
  assert.ok(verify.includes('<report>\n**Visual acceptance: ACCEPTED**\n</report>'));
  assert.match(buildPrompt({ role: 'implementer', deliverable: 'report', packet, packetDigest: digest, repository: 'example-org/sampleapp', baseSha: 'b'.repeat(40) }), /read AGENTS\.md/,
    'other providers keep the repository prompt');
});

test('a campaign routes its web task to agy for acceptance and verification, and its code task elsewhere', { skip: skipWithoutSqlite }, async (t) => {
  const { Store } = await import('../../src/supervisor/store.mjs');
  const { Controller } = await import('../../src/supervisor/controller.mjs');
  const { campaignStart } = await import('../../src/supervisor/api.mjs');
  const env = environment();
  const agyState = join(env.tmp, 'agy');
  mkdirSync(agyState);
  process.env.FAKE_AGY_STATE = agyState;
  const config = { ...env.config, commands: { ...env.config.commands, agy: [process.execPath, FAKE_AGY], chrome: fakeChrome(t, '155.0.8059.39') } };
  const store = new Store(join(env.dataDir, 'supervisor.db'));
  const d = declaration({ tasks: [{ ...declaration().tasks[0], deliverable: 'report' }, { ...webTask, dependsOn: ['T1'] }] });
  d.executor = chain(agy, claudeProvider);
  campaignStart(store, d);
  const controller = new Controller({ store, config, dataDir: env.dataDir, fault: null });
  t.after(() => { controller.release(); store.close(); env.cleanup(); delete process.env.FAKE_AGY_STATE; });
  await runUntil(controller, store, d.campaignId, (c) => c.control === 'finished');
  const ops = store.all('SELECT task_id, kind, executor_kind, run_dir, outcome FROM operations WHERE campaign_id = ? ORDER BY created_at', d.campaignId);
  assert.deepEqual(ops.map((op) => `${op.task_id}.${op.kind}:${op.executor_kind}`),
    ['T1.implement:claude-cli', 'T1.verify:claude-cli', 'W1.implement:agy-cli', 'W1.verify:agy-cli']);
  assert.ok(ops.every((op) => op.outcome.class === 'result'));
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

for (const mode of ['violation', 'long-violation']) test(`a boundary violation holds the web task for the owner instead of retrying it (${mode})`, { skip: skipWithoutSqlite }, async (t) => {
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
  await runUntil(controller, store, d.campaignId, () => store.task(d.campaignId, 'W1').blocked?.class === 'B3');
  for (let tick = 0; tick < 5; tick++) await controller.tick();
  const task = store.task(d.campaignId, 'W1');
  assert.match(task.blocked.reason, /boundary violation on agy-cli: browser worker used an unexpected tool \(search_web\)/);
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
