// Reuse only a settled, independently accepted code verdict. A worker never supplies this proof.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from './campaign.mjs';
import { packetDigest } from '../../scripts/lib/worker-context.mjs';
import { gateHeadProblem } from './gate.mjs';
import { fullCheckPassed } from './result-review.mjs';

const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const POLICY = JSON.parse(readFileSync(new URL('../../registry/worker-context-policy.json', import.meta.url), 'utf8'));
export const reportDigest = (report) => createHash('sha256').update(String(report ?? ''), 'utf8').digest('hex');

export function codeEvidence(store, campaign, task, proof) {
  if (!proof || typeof proof.operation !== 'string' || !/^[0-9a-f]{40}$/.test(proof.head ?? '') ||
      !/^[0-9a-f]{40}$/.test(proof.base ?? '') || !/^[0-9a-f]{64}$/.test(proof.report ?? '') ||
      !/^[0-9a-f]{64}$/.test(proof.outcome ?? '') || proof.head !== task.head_sha || proof.base !== task.base_sha ||
      proof.scope !== campaign.scope_digest || proof.authorization !== campaign.authorization_version) return null;
  const op = store.get('SELECT * FROM operations WHERE id = ?', proof.operation);
  const value = op?.outcome?.value;
  let packetHash;
  try { packetHash = packetDigest(op?.packet, POLICY); } catch { return null; }
  if (!op || op.campaign_id !== campaign.id || op.task_id !== task.task_id || op.kind !== 'verify' ||
      op.state !== 'finished' || op.publication_rewrite || op.outcome?.class !== 'result' ||
      op.outcome.receipt?.sessionId !== op.session_id || op.target_sha !== proof.head ||
      op.packet?.revision !== proof.head || op.packet?.authorityDigest !== proof.authority ||
      op.packet_digest !== packetHash || value?.targetSha !== proof.head ||
      value.reportDigest !== proof.report || op.report_digest !== proof.report || value.codeBaseSha !== proof.base || op.verification_base_sha !== proof.base ||
      value.verdict !== 'accepted' || value.baseFailures || value.knownDefects ||
      !fullCheckPassed(value.gate) || gateHeadProblem(value.gate, proof.head) || digest(op.outcome) !== proof.outcome) return null;
  const implementation = store.all("SELECT * FROM operations WHERE campaign_id = ? AND task_id = ? AND kind = 'implement' AND state = 'finished' ORDER BY seq DESC",
    campaign.id, task.task_id).find((row) => row.outcome?.class === 'result' && row.outcome.value?.result === 'resolved' &&
      row.outcome.receipt?.sessionId === row.session_id && row.session_id !== op.session_id &&
      row.outcome.value.headSha === proof.head && reportDigest(row.outcome.value.report) === proof.report);
  return implementation ? { op, value, report: implementation.outcome.value.report } : null;
}

export function captureCodeEvidence(store, campaign, task) {
  const existing = task.verification?.codeEvidence;
  if (existing) return codeEvidence(store, campaign, task, existing) ? existing : null;
  if (task.verified_sha !== task.head_sha || !task.base_sha || task.verification?.verdict !== 'accepted') return null;
  const op = store.all("SELECT * FROM operations WHERE campaign_id = ? AND task_id = ? AND kind = 'verify' AND state = 'finished' ORDER BY seq DESC",
    campaign.id, task.task_id).find((row) => !row.publication_rewrite && row.target_sha === task.verified_sha &&
      row.outcome?.class === 'result' && row.outcome.value && digest(row.outcome.value) === digest(task.verification));
  if (!op) return null;
  const proof = { operation: op.id, head: task.head_sha, base: task.base_sha, scope: campaign.scope_digest,
    authorization: campaign.authorization_version, authority: op.packet?.authorityDigest,
    report: op.report_digest, outcome: digest(op.outcome) };
  return codeEvidence(store, campaign, task, proof) ? proof : null;
}
