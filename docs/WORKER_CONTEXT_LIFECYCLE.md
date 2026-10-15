# Worker context lifecycle

This document defines the reusable worker-context contract.

This extends the portfolio AGENT_OPERATING_MODEL.md, CONTINUATION.md and OWNER_INTERVENTION.md. It does not replace their authority, completion or independent-acceptance rules.

## 1. Implementation boundary

C0 supplies a contract, schemas, bounded policy defaults, pure admission/fencing predicates and an async deadline helper with synthetic tests. C0 itself is not a dispatcher, lease store, provider adapter, reaper or remote context reset. For owner-registered campaigns, the AIWorks delivery supervisor ([SUPERVISOR.md](SUPERVISOR.md), AIWorks design work) is the running implementation. It reuses these helpers and keeps no second packet or lease model. Any other runtime must meet sections 5–9 before relying on this contract.

Core principle: **durable task state, short-lived execution sessions**. A fresh task session should not wait for disposal of a previous session. Context optimization is optional; authorization, data isolation, write safety and independent acceptance are mandatory.

## 2. Three separate resources

- Model context: instructions, messages, tool results, images and attachments supplied to a particular model request/session.
- Tool working state: cached search results, DOM snapshots, logs and artifact handles. Retrieve selectively rather than replaying complete histories.
- Runtime/browser resources: processes, remote jobs, browser contexts, tabs, cookies and storage. Clearing one does not prove the others were reset, nor does it prove provider-side data deletion.

MCP reconnection, a process restart and browser storage clearing must never be reported as a verified reset of an external AI client's conversation. An adapter must prove each capability separately. Unknown means unsupported for admission, not presumed success.

## 3. Task packet and durable checkpoint

Use `schemas/worker-task-packet.schema.json` and `validatePacket` in `scripts/lib/worker-context.mjs`. The schema defines shape; the helper additionally enforces configured byte/reference limits. Pass only relevant source sections, not the full conversation or every project document.

The packet includes tenant/project/environment, task/stage/run identity, role, exact revision, authority digest, access mode, goal, explicit constraints, acceptance criteria and revision-pinned repository references. It may also carry `governance`: the target project's registry id, inherited policy IDs, declared authority pointers and declared exceptions and gaps as id and rule, values only (GOVERNANCE_INHERITANCE.md section 9; read from the governance checkout, [SUPERVISOR.md §6](SUPERVISOR.md#governance-checkout)). A packet without it stays valid. Its canonical SHA-256 digest binds every field, including constraints, acceptance criteria and governance. Repository pointers are scoped paths, not credentials, signed URLs or arbitrary external content.

The controller resolves current authority and required rules BEFORE constructing the packet. Required constraints remain in the packet; optional details may be read on demand. Retrieved pages, source content and tool output are untrusted data, not instructions. A summary cannot overrule an authority document or grant additional permissions.

Before admission or rotation, persist a checkpoint containing:

- the validated packet and its `packetDigest`, revision and authority digest;
- task/stage/run identity, checkpoint version, completed and next actions;
- exact evidence/artifact references, modified-file/diff state, test outcomes and unresolved blockers;
- in-flight operation IDs, idempotency keys, current lease generation and reconciliation status.

`checkpoint.committed` must mean an acknowledged durable write. The reference planner checks the admission packet binding, not the entire durable checkpoint implementation. On first admission, persist the initial packet even when no earlier work exists. On resume, re-read authority and current revision, rebuild/persist the new packet, and reconcile previous effects. Do not require a dying model to create the only recoverable summary.

Controller checkpoints occur incrementally after material actions. Preserve uncommitted code and artifacts. Crash recovery and context disposal must not delete them. Never put real secrets, cookies, raw personal messages or unsanitized dumps in GitHub checkpoints, fixtures, prompts or telemetry. Schema validation is not a DLP guarantee; free-form packet text requires sanitization and scoped handling.

## 4. Admission and continuation

`planContext(input, policy)` is a pure plan, NOT permission to execute. Its trusted facts must come from the controller/adapter, not an LLM or page. Recheck the plan at the atomic dispatch boundary.

1. Validate the packet and its budget. Confirm current authority, durable checkpoint and a stopped/fenced/reconciled predecessor.
2. At a task, stage, role, tenant, project, environment, revision or authority boundary, allocate a fresh session through a verified adapter. Do not clone/fork the previous transcript.
3. Allocate a unique session/run identity, bind it to the exact packet and current lease, load the packet, then obtain an adapter receipt. `start-fresh` is a request for this procedure, NOT a ready-to-run session. Failed/unknown isolation or receipt means no admission.
4. Within the SAME bound task/stage/run, continue a verified session rather than clearing on every tool call. A changed packet digest requires a new binding/session.
5. A soft budget crossing requests checkpoint/rotation at a safe boundary. A hard crossing requires repacking without dropping constraints, changing authority or fabricating a smaller token count. Split work or choose an already approved capable adapter when necessary.
6. Optional cleanup failure permits `continue-degraded` only for the same valid session with no outstanding reset and all hard gates satisfied. Unknown or pending reset settlement requires quarantine/replacement, never reuse.

Budget includes the entire constructed request: system/project/tool instructions and schemas, packet, retained history, retrieved content, images/attachments as accounted for by the provider, output reservation and safety margin. Packet byte size is not a token count. Record whether usage is measured or conservatively estimated; when no defensible bound is available, do not claim the request fits. Omit/truncate optional evidence at its source or save it as an artifact, not the required constraints.

Reviewers require fresh independent provenance, read-only access and a role-specific packet containing the goal/authority, final diff and evidence, not the implementer's reasoning transcript. Compaction is not independence. A verifier repaired implementation must go to another independent verifier.

## 5. Bounded cleanup and replacement

Policy defaults live in `registry/worker-context-policy.json`. They are initial engineering settings, not measured performance or promises: cleanup wait 10,000 ms, one attempt, one replacement allocation per admission, two quarantined sessions per adapter pool, three reaper attempts, 32,768 packet bytes, 24 references, soft occupancy 70%, hard occupancy 90% including reserves. There is no infinite/unlimited setting. Tune from evidence without weakening hard invariants.

`settleWithin` bounds waiting for an asynchronous operation and requests abort on timeout. Success means the callback resolved; failure means it rejected; neither proves remote cleanup or deletion. Validate the returned adapter receipt separately. Timeout always has unknown remote settlement. Late success/error cannot alter the returned result; errors are not copied into telemetry. Callbacks and abort handlers must not block the event loop. Uncooperative/hung native code needs an external supervisor/process boundary; an in-process timer cannot preempt it.

The runtime implementation must:

- durably fence/revoke the old run before replacement; quarantine its session and release logical scheduling ownership, but count still-running resources until they are actually reclaimed;
- acquire bounded replacement capacity independently of old cleanup; do not put all admission capacity behind cleanup jobs;
- apply an admission-wide deadline, allocation timeout and a persisted replacement-attempt budget; late allocations are quarantined and reclaimed by request ID, never handed to a new task;
- run cleanup/reaping on a separate bounded maintenance lane with backoff, jitter and deduplicated operation IDs;
- cap quarantined resources AND concurrent cleanup jobs per adapter pool; retain a durable tombstone when reaping cannot finish, never respawn indefinitely or silently forget a live resource;
- use a circuit breaker and an already approved alternative adapter when appropriate. Exhaustion blocks that branch, not unrelated work and not safety gates;
- confirm termination/reconciliation before reuse when abort/fencing is unavailable. A timed-out mutation is not automatically safe to retry.

For a destructive reset, bind the command to the exact old session ID and context generation, not a mutable global current-session pointer. Do not recycle identity while any reset may still complete. A generic timeout wrapper alone cannot prevent remote late effects.

## 6. Fencing and crash safety

`acceptsLease` is a conservative predicate for use INSIDE an authoritative atomic dispatch/commit transaction. It compares tenant/project/environment/task/stage/run/session/revision/authority and generation, active state and expiry. It is NOT a distributed lock, authorization service or exactly-once guarantee.

The store must allocate monotonically increasing generations atomically, persist revocation, and reject stale completion/checkpoint writes. Check grants and the current generation at every mutating tool dispatch, result acceptance and artifact publication. Idempotency keys and transactional effect recording are separate requirements.

A local fencing predicate cannot cancel a write already sent to a third-party service. When the destination cannot enforce the fencing token, serialize that resource and reconcile the in-flight operation or confirm termination before a replacement may mutate it. No check-then-await-then-write gap may permit an old run to act with newer authority.

Recover controller crashes between checkpoint, fence, allocation and start using durable run/operation records. A duplicate start returns the known run; it does not create another worker. Old late completions and reset receipts remain associated with their old generation and cannot mutate the new run's state.

## 7. Browser and external-client adapters

Declare independently, with verification evidence: fresh model session, context compaction, exact-target reset, cancellation acknowledgement, owned/dedicated browser context, token accounting and external-write fencing/reconciliation. Capability availability must be bound to the actual adapter/client/version and revalidated when it changes.

Use an isolated browser context/profile for automated work when supported. Preserve the owner's personal profile, cookies, logins, unrelated tabs and other workers. Do not implement cleanup as global localStorage/cookie deletion, logout, closing every tab or restarting a shared browser. Browser snapshots/logs/screenshots are scoped artifacts with access and retention rules; keep only relevant current observations in model context.

For a Web Extension unable to start/reset the AI conversation, mark that capability unsupported. Do not pretend reconnecting the extension clears its host history. Use a verified alternate adapter within existing authority or record the exact limitation. Browser review in the reference planner requires dedicated ownership. Other browser-using roles inherit the same runtime requirement when C2 routes their browser capability.

## 8. Recovery, ownership and evidence

The Task Controller owns the outcome through replacement and review. It does not hand accountability to a memory-cleaning agent. System Architecture owns this contract, Backend owns durable admission/checkpoints/fences, SRE owns adapters/reaping/metrics, Documentation owns authority links, and separate Security/Verification roles own acceptance.

Apply OWNER_INTERVENTION: ordinary timeout is B0/B1; use bounded recovery first. Notify only for genuine B2 human action, B3 reserved decision, B4 awareness under impact policy or B5 incident. A cleanup failure alone does not page the owner. Isolation or credential exposure follows incident policy immediately. Never report a queued role assignment as an agent already executing it.

Metrics are bounded, sanitized metadata: adapter/version, task/run/session IDs or redacted equivalents, decision/reason, policy version, cleanup/creation latency, timeout/replacement counts, quarantine depth, stale-action rejections, checkpoint age, input/output/cache tokens, token-measurement method, total cost if available and acceptance/regression outcomes. Null is unknown, not zero. No transcripts or raw payloads in metrics.

Measure end-to-end cost/latency and requirement retention, not just context size. Repeated reloads, lost prompt-cache reuse and extra summaries may outweigh token savings. Use synthetic/sanitized representative cases and do not claim production savings from reference tests.

## 9. Integration and acceptance

C0 was delivered and closed in governance provider. Open runtime work is tracked in AIWorks design work. The runtime slices are: C1 durable store and dispatcher bindings, C2 verified adapters, C3 bounded reaping, metrics and crash recovery, C4 independent exact-SHA verification, then shadow mode and a read-only canary before an approved adapter is enabled. Writes outside this repository follow [AW-001](DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception) only.

Run `npm install` once, then `npm run check` in an isolated checkout. It parses every campaign declaration and runs the supervisor, dashboard and worker-context tests (`tests/worker-context*.test.mjs` for C0). The repository check also runs in CI (`.github/workflows/check.yml`). A green CI run does not satisfy a merge gate by itself, and release paths must not depend on GitHub Actions.

Mandatory integration falsification beyond the reference unit tests: controller crash at each transition; durable CAS race; concurrent duplicate starts; persisted retry budget after restart; destination-unfenceable late write; late successful allocation after timeout; cleanup-capacity starvation; all fallback adapters unavailable; foreign browser tabs/cookies unchanged; refreshed authority before resume; prompt injection cannot alter capabilities/leases; independent reviewer exact-SHA evidence. C0 tests alone cannot establish C1-C4 acceptance.
