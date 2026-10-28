// Owner guidance is delivered at the next task dispatch, without changing its authority.
export function pendingInstructions(store, campaign, taskId, role) {
  return store.all("SELECT * FROM events WHERE campaign_id = ? AND kind = 'agent-instruction' ORDER BY seq", campaign.id)
    .filter(({ payload }) => payload.taskId === taskId && (!role || payload.role === role) && !payload.delivery &&
      payload.authorizationVersion === campaign.authorization_version && payload.scopeDigest === campaign.scope_digest);
}

export function attachInstructions(store, instructions, operationId, now) {
  for (const instruction of instructions) {
    store.run('UPDATE events SET payload = ?, processed_at = ? WHERE seq = ?',
      { ...instruction.payload, delivery: { operationId, at: now } }, now, instruction.seq);
    store.journal(instruction.campaign_id, 'instruction-attached', { op: operationId, instruction: instruction.seq }, now);
  }
}

// Unlike ordinary one-use guidance, an applied owner decision is evidence for every
// later run of both roles. Read the controller's durable receipt, including receipts
// created before this change. Stale authority and other tasks never inherit it.
export function decisionInstructions(store, campaign, taskId) {
  return store.all("SELECT * FROM events WHERE campaign_id = ? AND kind = 'agent-instruction' ORDER BY seq", campaign.id)
    .filter(({ dedup_key, payload }) => dedup_key?.startsWith(`instruction:decision:${campaign.id}:`) &&
      payload.taskId === taskId && payload.authorizationVersion === campaign.authorization_version &&
      payload.scopeDigest === campaign.scope_digest);
}
