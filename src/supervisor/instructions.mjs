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
