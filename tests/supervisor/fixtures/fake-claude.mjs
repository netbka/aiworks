#!/usr/bin/env node
// Synthetic stand-in for `claude -p` in supervisor tests. It makes no model or network calls.
// Behaviour per call comes from <FAKE_CLAUDE_STATE>/scenario.json: { implement: [mode...], verify: [mode...], gate }.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const valueOf = (list, flag) => { const index = list.indexOf(flag); return index >= 0 ? list[index + 1] : null; };
const option = (flag) => valueOf(args, flag);
const sessionId = option('--session-id');
const prompt = readFileSync(0, 'utf8');
const role = prompt.includes('INDEPENDENT VERIFIER') ? 'verify' : prompt.includes('AIWORKS COORDINATOR') ? 'coordinate' : 'implement';
const stateDir = process.env.FAKE_CLAUDE_STATE;
const scenario = JSON.parse(readFileSync(join(stateDir, 'scenario.json'), 'utf8'));
const callsFile = join(stateDir, 'calls.jsonl');
const model = option('--model');
const earlier = existsSync(callsFile)
  ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.role === role) : [];
const previous = earlier.length;
// Scenario per model (model routing): byModel.<model>.<role> lists the modes of that model's calls, counted per model.
const own = scenario.byModel?.[model]?.[role];
let mode = (own ? own[earlier.filter((call) => valueOf(call.args, '--model') === model).length] : scenario[role]?.[previous]) ??
  (role === 'implement' ? 'commit' : role === 'coordinate' ? 'coordinate' : 'accept');
// scenario.intake: every intake-mode coordinator call drafts the synthetic plan below (the owner-journey harness).
if (role === 'coordinate' && scenario.intake && prompt.includes('in intake mode')) mode = 'intake';
appendFileSync(callsFile, `${JSON.stringify({ role, sessionId, cwd: process.cwd(), mode, args,
  autoMemoryDisabled: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1', subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
  gitBashPath: process.env.CLAUDE_CODE_GIT_BASH_PATH ?? null, inheritedProbe: process.env.CLAUDE_CODE_PROBE_INHERITED ?? null, at: Date.now() })}\n`);

const git = (...gitArgs) => spawnSync('git', gitArgs, { encoding: 'utf8', windowsHide: true }).stdout.trim();
const emit = (body, code = 0) => { process.stdout.write(JSON.stringify(body)); process.exit(code); };
const ok = (value) => emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 3,
  total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
  permission_denials: [], structured_output: value, result: JSON.stringify(value) });
const target = (/Target commit: ([0-9a-f]{40})/.exec(prompt) ?? /MUST carry targetSha ([0-9a-f]{40})/.exec(prompt))?.[1];
const reportDigest = /reportDigest ([0-9a-f]{64})/.exec(prompt)?.[1];

// scenario.gate leaves the gate helper's files in a verifier's checkout, as src/supervisor/gate.mjs does: one { log, exit }
// for every verification, or a list with one per verification call. exit null leaves no gate-exit.log (an unfinished gate),
// and false leaves no gate files at all. Without one, a verifier leaves a passing gate, as the full-gate rule requires.
const PASSING = { log: '# all test files: 1 unit, 0 service, 0 rehearsal (of 1)\n# tests 1\n# pass 1\n# fail 0\n', exit: '0' };
const gate = role === 'verify' ? ((Array.isArray(scenario.gate) ? scenario.gate[previous] : scenario.gate) ?? PASSING) : null;
if (gate) {
  writeFileSync(join(process.cwd(), 'gate.log'), gate.log);
  if (gate.exit !== null) writeFileSync(join(process.cwd(), 'gate-exit.log'), `${gate.exit}
`);
}

// Assembled at run time so the fixture source itself passes the public-scope check.
const LEAK_PATH = ['C:', 'Users', 'synthetic-owner', 'sampleapp', 'src', 'work.mjs'].join('\\');

const sleep = /^sleep:(\d+):(.+)$/.exec(mode);
if (sleep) {
  await new Promise((done) => setTimeout(done, Number(sleep[1])));
  mode = sleep[2];
}

switch (mode) {
  case 'commit-settings': { // an implementer that tries to steer later workers through the project settings
    mkdirSync(join(process.cwd(), '.claude'), { recursive: true });
    writeFileSync(join(process.cwd(), '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_GIT_BASH_PATH: 'C:/evil/bash.exe' } }));
    git('add', '-A');
    git('commit', '-q', '-m', `settings ${sessionId}`);
    ok({ result: 'resolved', summary: 'implemented', headSha: git('rev-parse', 'HEAD'), report: `# Report\n\nsession ${sessionId}` });
    break;
  }
  case 'commit-big': { // a verified commit whose report fills most of a GitHub body
    writeFileSync(join(process.cwd(), `work-${sessionId}.txt`), `work by ${sessionId}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `work ${sessionId}`);
    ok({ result: 'resolved', summary: 'implemented', headSha: git('rev-parse', 'HEAD'), report: `# Report\n\n${'r'.repeat(50000)}` });
    break;
  }
  case 'report-big':
    ok({ result: 'resolved', summary: 'researched', report: `# Findings\n\n${'r'.repeat(50000)}` });
    break;
  case 'intake': // a draft plan for one owner request: the shape coordinator.mjs INTAKE_SCHEMA asks for
    ok({ summary: 'Add a greeting to the home page.', plan: `# Plan

Change the home page heading and note the change.`,
      steps: [{ title: 'Change the heading', check: 'The page shows the new heading' }], questions: [],
      declaration: { outcome: 'The home page greets the visitor.', acceptance: ['The home page shows the new heading'],
        writes: ['index.html', 'src'], deliverables: ['commit'], constraints: ['Change only the home page and its note'],
        tasks: [{ id: 'GREETING', title: 'Greeting', goal: 'Change the home page heading', acceptance: ['The home page shows the new heading'],
          references: ['AGENTS.md'], deliverable: 'commit', writes: ['index.html', 'src'], dependsOn: [] }] },
      outline: { checks: ['Open the page'], included: ['A new heading'], later: ['Styling'], estimate: { amount: 1, unit: 'hours' } } });
    break;
  case 'probe-commit-page': { // a worker that tries the owner's Apply on the dashboard at scenario.probe, then does its work
    const base = scenario.probe, headers = { Origin: base.replace(/\/$/, ''), 'Content-Type': 'application/json' }, out = { at: Date.now() };
    try {
      const { csrf } = await (await fetch(`${base}api/session`, { headers })).json();
      const local = (await (await fetch(`${base}api/state`, { headers })).json()).work?.local ?? {};
      const row = Object.values(local).flat().flatMap((c) => c.results).find((result) => result.action === 'apply');
      const response = await fetch(`${base}api/work/apply`, { method: 'POST', headers: { ...headers, 'X-Dashboard-CSRF': csrf },
        body: JSON.stringify({ requestId: randomUUID(), campaignId: row?.campaignId, taskId: row?.taskId, seq: row?.seq }) });
      Object.assign(out, { target: row ? `${row.campaignId}/${row.taskId}/${row.seq}` : null, status: response.status, body: await response.json() });
    } catch (error) { out.error = String(error.message); }
    appendFileSync(join(stateDir, 'probe.jsonl'), `${JSON.stringify(out)}
`);
  }
  // falls through to the page change
  case 'commit-page': { // a page change a preview can show: the home page heading and a note
    writeFileSync(join(process.cwd(), 'index.html'), `<!doctype html><title>Notes</title><h1>Hello from ${sessionId.slice(0, 8)}</h1>
`);
    mkdirSync(join(process.cwd(), 'src'), { recursive: true });
    writeFileSync(join(process.cwd(), 'src', 'greeting.txt'), `greeting by ${sessionId}
`);
    git('add', '-A');
    git('commit', '-q', '-m', `greeting ${sessionId}`);
    ok({ result: 'resolved', summary: 'implemented', headSha: git('rev-parse', 'HEAD'), report: `# Report

Changed the heading (session ${sessionId}).` });
    break;
  }
  case 'commit':
  case 'dirty': {
    // scenario.commitDir keeps the work inside a declared write domain (a task with `writes`).
    const dir = join(process.cwd(), scenario.commitDir ?? '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `work-${sessionId}.txt`), `work by ${sessionId}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `work ${sessionId}`);
    if (mode === 'dirty') writeFileSync(join(process.cwd(), 'uncommitted.txt'), 'left behind\n');
    ok({ result: 'resolved', summary: 'implemented', headSha: git('rev-parse', 'HEAD'), report: `# Report\n\nsession ${sessionId}` });
    break;
  }
  case 'commit-leak': { // a commit whose report cites a synthetic absolute installation path (aiworks#8)
    writeFileSync(join(process.cwd(), `work-${sessionId}.txt`), `work by ${sessionId}
`);
    git('add', '-A');
    git('commit', '-q', '-m', `work ${sessionId}`);
    ok({ result: 'resolved', summary: 'implemented', headSha: git('rev-parse', 'HEAD'), report: `# Report

Ran ${LEAK_PATH}` });
    break;
  }
  case 'commit-same': // a publication repair: the same commit, a corrected report
    ok({ result: 'resolved', summary: 'report corrected', headSha: git('rev-parse', 'HEAD'), report: `# Report

Ran src/work.mjs (session ${sessionId})` });
    break;
  case 'report':
    ok({ result: 'resolved', summary: 'researched', report: `# Findings\n\nsession ${sessionId}` });
    break;
  case 'leak': // a coordinator induced to put a credential into its reply
    ok({ summary: 'leaked', reply: `found token ghp_${'A'.repeat(36)} in a file`, newWork: [], plan: 'none' });
    break;
  case 'tamper': // a misbehaving coordinator that writes into its checkout before answering
    writeFileSync(join(process.cwd(), 'tampered.txt'), 'changed by the agent\n');
  // falls through to a normal answer
  case 'coordinate':
    ok({ summary: 'two new items reviewed', reply: `Reviewed as asked (session ${sessionId}).`,
      newWork: [{ repository: 'example-org/sampleapp', number: 455, kind: 'issue', title: 'Telegram ingestion SQL contract', classification: 'new-campaign-candidate', reason: 'defect on main', wave: 1 },
        { repository: 'example-org/sampleapp', number: 461, kind: 'pr', title: 'Readable WhatsApp contacts', classification: 'needs-review-or-merge', reason: 'open PR awaiting review' }],
      plan: 'Wave 1: #455 with independent verification.', proposedCampaign: '{"campaignId":"sampleapp-next"}' });
    break;
  case 'owner':
    ok({ result: 'blocked-owner-reserved', summary: 'needs owner', ownerTrigger: 'Constitution 2: paid spend decision' });
    break;
  case 'owner-leak': // an owner-reserved result whose trigger text carries synthetic credential-shaped values (aiworks#1)
    ok({ result: 'blocked-owner-reserved', summary: 'needs owner',
      ownerTrigger: `Rotate key ${['sk', 'ant', 'api03', 'SYNTHETICfakeVALUE0123456789abcdef'].join('-')} with password=SYNTHETICfakePassphrase then decide` });
    break;
  case 'unavailable': // a worker that cannot proceed and says so (the WAVE-06 shape, historical regression)
    ok({ result: 'evidence-unavailable', summary: 'cannot proceed', tried: 'synthetic: no cohort assigned within the authorization' });
    break;
  case 'no-result':
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'done' });
    break;
  case 'auth':
    emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, session_id: sessionId, result: 'Invalid API key - Please run /login' }, 1);
    break;
  case 'accept-big': // an acceptance whose checks and notes push report + verification past 65,536 characters
    ok({ verdict: 'accepted', targetSha: target, reportDigest, summary: `VERIFIED-SUMMARY ${'s'.repeat(3800)}`, checks: Array.from({ length: 12 }, (_, i) => ({ command: `check-${i}`, result: 'pass', detail: 'd'.repeat(1000) })),
      findings: Array.from({ length: 3 }, (_, i) => ({ id: `N${i}`, severity: 'non-blocking', description: 'n'.repeat(1500) })) });
    break;
  case 'accept-leak': // an acceptance whose check detail cites a synthetic absolute installation path (aiworks#8)
    ok({ verdict: 'accepted', targetSha: target, reportDigest, summary: 'all acceptance criteria hold', findings: [], checks: [{ command: 'npm test', result: 'pass', detail: `ran in ${LEAK_PATH}` }] });
    break;
  case 'accept':
    ok({ verdict: 'accepted', targetSha: target, reportDigest, summary: 'all acceptance criteria hold', findings: [], checks: [{ command: 'npm test', result: 'pass' }] });
    break;
  case 'reject':
    ok({ verdict: 'rejected', targetSha: target, reportDigest, summary: 'criterion 1 fails', findings: [{ id: 'F1', severity: 'blocking', description: 'missing evidence for criterion 1' }], checks: [] });
    break;
  case 'accept-failed-check': // the contradiction the controller refuses (aiworks#59): accepted, with a check marked fail
    ok({ verdict: 'accepted', targetSha: target, reportDigest, summary: 'all acceptance criteria hold', findings: [], checks: [{ command: 'npm test', result: 'fail', detail: 'expected failure on the base' }] });
    break;
  case 'reject-unblocked': // rejected with no blocking finding, also refused (aiworks#59)
    ok({ verdict: 'rejected', targetSha: target, reportDigest, summary: 'minor notes', findings: [{ id: 'N1', severity: 'non-blocking', description: 'wording' }], checks: [] });
    break;
  case 'wrong-target':
    ok({ verdict: 'accepted', targetSha: '0'.repeat(40), reportDigest, summary: 'looked at something else', findings: [], checks: [] });
    break;
  case 'unknown-model': // the provider does not know the requested model, as the CLI reports it before any work
    emit({ type: 'result', subtype: 'success', is_error: true, session_id: sessionId, num_turns: 1, total_cost_usd: 0,
      result: `There's an issue with the selected model (${model}). It may not exist or you may not have access to it.` }, 1);
    break;
  case 'quota': // subscription limit refusal before any work, as the CLI reports it (no parseable reset here)
    emit({ type: 'result', subtype: 'success', is_error: true, session_id: sessionId, num_turns: 1, total_cost_usd: 0, result: "You've hit your session limit" }, 1);
    break;
  case 'hang':
    await new Promise((done) => setTimeout(done, 60_000));
    ok({ result: 'resolved', summary: 'late', report: 'late' });
    break;
  default:
    process.stderr.write(`unknown fake mode ${mode}\n`);
    process.exit(9);
}
