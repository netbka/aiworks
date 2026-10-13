#!/usr/bin/env node
// Read-only observer. Uses explicit checkout/data paths; never registers, resumes, merges or deploys.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const take = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const checkout = take('--checkout'), data = take('--data'), campaign = take('--campaign'), output = take('--output');
const interval = Number(take('--interval-ms') ?? 60_000);
if (![checkout, data, output].every((path) => path && isAbsolute(path)) || !/^[a-z0-9][a-z0-9-]*$/.test(campaign ?? '') ||
    !Number.isSafeInteger(interval) || interval < 10_000) {
  console.error('Usage: node watch-campaign.mjs --checkout <absolute runtime path> --data <absolute data path> --campaign <id> --output <absolute snapshot path> [--once] [--interval-ms <10000 or more>]');
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true });
let previous = null;
do {
  const run = spawnSync(process.execPath, [join(checkout, 'src/supervisor/cli.mjs'), 'status', campaign, '--data', data],
    { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  let snapshot;
  try {
    if (run.status !== 0) throw new Error('status-failed');
    const s = JSON.parse(run.stdout);
    snapshot = { observedAt: s.observedAt, campaignId: s.campaignId, store: s.store, readiness: s.readiness,
      phase: s.phase, control: s.control, controller: { live: s.controller.live, codeRevision: s.controller.codeRevision },
      lastProgressAt: s.lastProgressAt, nextWakeupAt: s.nextWakeupAt, runsUsed: s.runsUsed,
      tasks: s.tasks.map((t) => ({ id: t.id, state: t.state, headSha: t.headSha, verifiedSha: t.verifiedSha,
        prUrl: t.prUrl, blockedClass: t.blocked?.class ?? null,
        wait: t.wait ?? (String(t.lastError ?? '').startsWith('dependency-integration:') ? { code: 'integration' } : null) })),
      openOperations: s.openOperations.map(({ id, taskId, kind, state }) => ({ id, taskId, kind, state })) };
  } catch {
    // Never copy stderr, errors or worker output to the observer log.
    snapshot = { observedAt: new Date().toISOString(), campaignId: campaign, observationError: 'status-unavailable', exitCode: run.status };
  }
  writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n');
  const { observedAt, nextWakeupAt, ...state } = snapshot;
  const key = JSON.stringify({ ...state, ...(state.tasks ? { tasks: state.tasks.map((task) => ({ ...task,
    wait: task.wait ? { ...task.wait, until: null } : null })) } : {}) });
  if (key !== previous) {
    appendFileSync(output + '.changes.jsonl', JSON.stringify(snapshot) + '\n');
    console.log(JSON.stringify(snapshot));
    previous = key;
  }
  if (args.includes('--once')) process.exit(snapshot.observationError ? 1 : 0);
  await delay(interval);
} while (true);
