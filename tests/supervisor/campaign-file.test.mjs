// The committed Dyk campaign must validate and every task must fit the engineering-platform-archive#47 C0 packet budget
// for both roles, including room for the maximum number of carried verifier findings and the
// target project's governance block.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { packetDigest, planContext, validatePacket } from '../../scripts/lib/worker-context.mjs';
import { dispatchBudget } from '../../src/supervisor/controller.mjs';
import { buildPrompt } from '../../src/supervisor/adapters/executors.mjs';
import * as campaign from '../../src/supervisor/campaign.mjs';
import { GOVERNANCE, ROOT } from './helpers.mjs';

const policy = JSON.parse(readFileSync(join(ROOT, 'registry/worker-context-policy.json'), 'utf8'));

const { authorityDigest, validateDeclaration } = campaign;

test('Wiki broker maximum and a full accepted report fit real implementer/verifier admission', () => {
  const decl = validateDeclaration(JSON.parse(readFileSync(join(ROOT, 'campaigns/elma-wiki-planning.json'))));
  const task = decl.tasks[0], sha = 'a'.repeat(40);
  for (const role of ['implementer', 'verification']) {
    const packet = validatePacket({ version: 1, tenantId: decl.target.tenantId, projectId: decl.target.projectId,
      environment: decl.target.environment, taskId: task.id, stageId: role, runId: 'budget-rehearsal', role,
      revision: sha, authorityDigest: authorityDigest(decl), access: 'read-only',
      goal: `${task.title} (${decl.target.repository}#${task.issue}). ${task.goal}`.slice(0, 2000),
      constraints: decl.constraints, acceptance: task.acceptance, references: task.references.map((path) => ({ path, revision: sha })),
      governance: campaign.projectGovernance(decl.target.repository, GOVERNANCE) }, policy);
    const digest = packetDigest(packet, policy);
    const prompt = buildPrompt({ role, deliverable: 'report', packet, packetDigest: digest, repository: decl.target.repository,
      // The verifier always carries the full report. The implementer carries it only in a report-repair round
      // (main's <rejected-report>); a repair with both a maximum broker capture and a maximum report exceeds
      // the hard budget and is refused at admission without consuming a run (follow-up on engineering-platform-archive#64).
      issue: task.issue, branch: 'synthetic', baseSha: sha, targetSha: sha,
      report: role === 'verification' ? 'x'.repeat(52000) : null, reportDigest: role === 'verification' ? 'b'.repeat(64) : null }) + 's'.repeat(320000);
    const result = planContext({ packet, authorityCurrent: true, predecessorSafe: true, session: null,
      checkpoint: { ...packet, committed: true, packetDigest: digest }, budget: dispatchBudget(decl.executor.providers[0], role, prompt),
      capabilities: { freshSession: 'verified' }, replacementAttempts: 0, quarantinedSessions: 0, capacityAvailable: true }, policy);
    assert.equal(result.action, 'start-fresh', `${role}: ${result.reason}`);
  }
});

for (const name of readdirSync(join(ROOT, 'campaigns')).filter((file) => file.endsWith('.json'))) {
  test(`campaign ${name} validates and every packet fits the context policy`, () => {
    const decl = validateDeclaration(JSON.parse(readFileSync(join(ROOT, 'campaigns', name), 'utf8')));
    assert.ok(!JSON.stringify(decl.executor).includes('bypassPermissions'));
    const sha = 'a'.repeat(40);
    // The packet carries the target project's governance, resolved as at dispatch (engineering-platform-archive#84).
    const governance = campaign.projectGovernance(decl.target.repository, GOVERNANCE);
    for (const task of decl.tasks) {
      for (const role of ['implementer', 'verification']) {
        const findings = role === 'implementer' ? Array.from({ length: 8 }, (_, i) => `Blocking verifier finding F${i}: ${'x'.repeat(400)}`) : [];
        validatePacket({
          version: 1, tenantId: decl.target.tenantId, projectId: decl.target.projectId, environment: decl.target.environment,
          taskId: task.id, stageId: role === 'implementer' ? 'implement' : 'verify', runId: `${decl.campaignId}.${task.id}.x.99`,
          role, revision: sha, authorityDigest: authorityDigest(decl),
          access: role === 'verification' || task.deliverable === 'report' ? 'read-only' : 'write',
          goal: `${task.title} (${decl.target.repository}#${task.issue}). ${task.goal}`.slice(0, 2000),
          constraints: [...decl.constraints, ...(task.constraints ?? []), ...findings],
          acceptance: task.acceptance,
          references: task.references.map((path) => ({ path, revision: sha })),
          governance,
        }, policy);
      }
    }
  });
}
