#!/usr/bin/env node
// Synthetic stand-in for `agy` print mode (stream-json in and out) in supervisor tests. No model, browser or network.
// It records each call to <FAKE_AGY_STATE>/calls.jsonl and answers like a browser worker that opened the page.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const schema = JSON.parse(readFileSync(option('--json-schema'), 'utf8'));
const message = JSON.parse(readFileSync(0, 'utf8').split(/\r?\n/).find((line) => line.trim()));
const prompt = message.message.content;
const role = prompt.includes('INDEPENDENT VERIFIER') ? 'verify' : 'implement';
const home = process.env.USERPROFILE;
appendFileSync(join(process.env.FAKE_AGY_STATE, 'calls.jsonl'), `${JSON.stringify({ role, args, cwd: process.cwd(), home,
  settings: existsSync(join(home, '.gemini', 'antigravity-cli', 'settings.json')) ? JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) : null,
  mcp: existsSync(join(home, '.gemini', 'config', 'mcp_config.json')) ? JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')) : null,
  at: Date.now() })}\n`);

const conversation = `fake-agy-${process.pid}`;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const url = /^- (https?:\/\/\S+)$/m.exec(prompt)?.[1];
emit({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: ['call_mcp_tool', 'search_web'], permission_mode: 'request-review' } });
emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool',
  tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'browser', ToolName: 'navigate_page', Arguments: { pageId: 1, url } } } } });
// FAKE_AGY_MODE=violation: the session also runs a built-in that no permission rule can deny.
if (['violation', 'long-violation'].includes(process.env.FAKE_AGY_MODE)) emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 2, state: 'DONE',
  step_type: 'tool', tool_name: 'search_web', tool_info: { name: 'search_web', parameters: { query: 'anything' } } } });
// FAKE_AGY_MODE=long-violation: after that early violation, more than 4 MiB of ordinary events, as a long review writes.
if (process.env.FAKE_AGY_MODE === 'long-violation') {
  const filler = 'x'.repeat(8000);
  for (let index = 0; index < 700; index++) emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 3,
    state: 'ACTIVE', step_type: 'agent_response', text_delta: filler } });
}
const runId = schema.properties.runId.const;
const packetDigest = schema.properties.packetDigest.const;
const result = role === 'verify'
  ? { verdict: 'accepted', targetSha: /MUST carry targetSha ([0-9a-f]{40})/.exec(prompt)[1], reportDigest: /reportDigest ([0-9a-f]{64})/.exec(prompt)[1],
    summary: 'Re-checked every criterion in the browser.', findings: [], checks: [{ command: 'A1 page loads', result: 'pass' }], criteria: Array.from({ length: 16 }, (_, i) => ({ criterion: i + 1, result: 'pass', check: 'synthetic', evidence: 'synthetic' })) }
  : { result: 'resolved', summary: 'ACCEPTED; no failing criteria', report: `**Visual acceptance: ACCEPTED**\n\nPage: ${url}\n\n| Criterion | Result | Evidence |\n| --- | --- | --- |\n| A1 | pass | snapshot shows the heading |` };
emit({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: '', num_turns: 1,
  structured_output: { runId, packetDigest, result },
  usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 300, total_tokens: 120 } } });
