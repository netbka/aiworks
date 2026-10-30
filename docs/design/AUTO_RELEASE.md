# Opt-in automatic release with per-project authorization

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations and approval records stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Any proposal to publish declarations through source branches or pull requests is superseded. Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Implementation status:** [AW-010](../DECISIONS.md#aw-010---auto-release-is-a-separate-release-role-under-a-standing-per-project-grant) supplies the standing-grant model. Production continuation now connects `deploy` destinations after the existing merge gate, enabled per installation and authorized per project. It includes native command containment, grant continuity, preflight health and retained-artifact evidence, restart reconciliation and completion across expected destinations. See [the current runbook](../SUPERVISOR.md#12-automatic-project-releases). Other destination kinds are not connected to automatic continuation. No private grant or real deployment evidence belongs in this repository. The remainder is the original design; its historical and proposed statements do not establish current runtime behavior.

**Basis:** design notes; implementation status must be checked against the selected runtime revision.

**Inputs:** [PROJECT_WORKSPACE_PLAN.md §5.5](../PROJECT_WORKSPACE_PLAN.md#55-separate-auto-release-mode-owner-approved-d5-tracked-13) and decision D5, #13, [DECISIONS.md](../DECISIONS.md) (AW-001, AW-005), [SUPERVISOR.md](../SUPERVISOR.md), [PRODUCT_CONSTITUTION.md](../PRODUCT_CONSTITUTION.md). governance rules are linked, not repeated: Constitution §14 Release authority, §15 Incident escalation, §2 Owner role, RELEASE-001, governance-029 standing deploy authorization, Delivery Practices §2 Release, the `release-agent` and `production-observer` roles in registry/agents.json, and the RELEASE target flow.

## 1. What the owner gets

Each project has a **Release mode** for each place it can be released to (a *destination*):

- **Review only** is the default and today's behaviour. AIWorks stops when a checked result is published, and says what the next human step is. It never merges, deploys or copies files into your folder.
- **Auto Release** is off until you grant it. Once granted for one project and one destination, AIWorks releases each checked result that the grant covers, checks it afterwards and rolls it back if the check fails. It does not ask you again for each routine release.

A grant is a short written record that answers four questions in plain words:

1. **What may be released?** For example: "documentation and ordinary code changes in sampleapp; never database migrations".
2. **Where?** One destination, for example "merge to `main` of example-org/sampleapp, then deploy to sampleapp production".
3. **What must pass first?** The independent check of that exact version, the project's own release checks, and a working way back.
4. **How do I stop it?** One switch stops all releases at once; switching a project back to Review only stops that project. The grant also expires by itself.

For every release you can see, without logs: what was released (the exact version and the change), where, whether each step happened, whether the checks after release passed, and the one button to stop or roll back. The steps are shown separately and never merged into one green tick:

| Step | Shown as |
| --- | --- |
| The work is done | Implemented |
| A separate checker accepted that exact version | Independently checked |
| GitHub merged it (GitHub projects only) | Merged |
| It is live at the destination, or applied to your folder | Deployed / Applied |
| The checks after release passed | Release checked |

Each step is **Yes**, **No**, **In progress** or **Unknown**. Unknown is never shown as success.

What it does **not** do:

- It does not release because a worker wrote "done". Only the independent check of the exact version counts.
- It does not release anything the grant does not name: no new destination, no new environment, no database migration that cannot be undone, no new paid service, no new permission. Those still come to you.
- It never repeats a release step whose outcome it does not know. After a crash it looks at the destination first.
- It never copies over files you changed in your own folder.
- It never releases AIWorks into its own live runtime. That stays the manual upgrade procedure in [AGENTS.md](../../AGENTS.md#review-and-runtime-maintenance).
- It is not on today. Section 11 says which parts can be built switched off now and which wait for you or for governance provider.

## 2. How it works today (observed)

### 2.1 The rule that forbids it

- AW-001: the supervisor "never merges, deploys or changes provider resources" (`docs/DECISIONS.md:11`). The agent contract repeats it (`AGENTS.md:19`), and so does the product constitution: "No merging, deploying or changing provider resources ... Merge and release follow each project's own gate" (`docs/PRODUCT_CONSTITUTION.md:35`).
- The runbook says the same for the target repository: "It never merges, deploys, removes worktrees or deletes branches" (`docs/SUPERVISOR.md:34`). Slices C (project release adapter) and D (install evidence and canary) are named as open (`docs/SUPERVISOR.md:3`).
- the governance contract's registry entry for AIWorks records this as the exception `campaign-external-write` against `constitution#8`, summary "...never merges or deploys", review by 2027-04-12 (`registry/projects/aiworks.json` in governance).
- The plan records D5 as product direction only: "This is **not** immediate authorization to merge/deploy" (`docs/PROJECT_WORKSPACE_PLAN.md:246`). §5.5 sets the shape this document details (`docs/PROJECT_WORKSPACE_PLAN.md:182-197`).
- Separately, the owner decided that **an agent** merging a PR whose exact head passed the supervisor's independent verification is not an owner stop (`AGENTS.md:55`, #17). That is about agent sessions working in this repository. It does not change AW-001 for the supervisor runtime.

### 2.2 Where today's flow stops

- A verifier's `accepted` verdict sets the task to `verified` and records `verified_sha` as the operation's `target_sha`, the exact commit the verifier checked (`src/supervisor/controller.mjs:420`).
- Publication pushes exactly that SHA, not a moving HEAD, and confirms the remote branch is at it (`src/supervisor/adapters/git.mjs:81-85`, called at `controller.mjs:830`). It then opens a PR, looking for an existing one first so a retry does not duplicate it (`src/supervisor/adapters/github.mjs:28-39`).
- Publication runs only while the campaign is `registered` and the task is still `verified` at the same row version (`controller.mjs:816`). It ends the task in state `done` with the PR URL (`controller.mjs:866`).
- The owner message says "Not merged; merge follows `<repository>`'s release gate" (`controller.mjs:870`), and the PR body says "Not merged and not deployed" (`controller.mjs:939`). A finished campaign's next action is "Release gate: review campaign deliveries under ... own merge and release policy" (`controller.mjs:968`), and its message ends "nothing was merged or deployed" (`controller.mjs:969`).
- So the release step does not exist in the supervisor. It is the line this design adds after `done`.

### 2.3 What already exists and is reused

- **Read-only merge receipt.** `integratedPullRequest` returns the merge commit only when the PR is `MERGED`, its head is the exact reviewed SHA and its base is the declared branch; any read failure returns `null` (`github.mjs:14-26`). Dependency gating uses it today (`controller.mjs:473-475`). This is the reconciliation read for the merge step.
- **Lookup before create.** The GitHub adapter checks before it creates, "so a retry after an unknown outcome reconciles instead of duplicating" (`github.mjs:1-3`). Report comments do the same with a marker (`controller.mjs:842-862`). The release steps follow the same rule.
- **Fenced writes and idempotency keys.** Every controller write runs inside `BEGIN IMMEDIATE` after `assertLease`, and the lease is extended while an external effect runs (`controller.mjs:141-150`, `src/supervisor/store.mjs:134`, `store.mjs:224`). Each operation has a unique `idempotency_key` (`store.mjs:40`, `controller.mjs:743`).
- **Fault injection for restart tests.** Named fault points such as `after-push` already exist (`controller.mjs:100`, `controller.mjs:831`).
- **Worker deny list.** Claude workers are denied `git push`, `gh pr merge`, `gh release`, `npm run deploy`, `ssh` and others (`src/supervisor/adapters/claude.mjs:67-71`). This is a tool allowlist, not an operating-system boundary (governance Constitution §9).
- **Standing deploy authorizations are already read.** The dashboard reads `governance.releaseAuthorization` from each governance registry entry (`src/dashboard/roadmap.mjs:31-50`) and names it in the owner view (`src/dashboard/owner.mjs:103-108`). The runbook lists it among the governance files read (`docs/SUPERVISOR.md:230`). It is display only.
- **The record governance accepts today is thin.** the governance contract's schema allows `releaseAuthorization` with exactly `source`, `approval` (a GitHub issue or PR URL) and `summary` (`schemas/project-contract.schema.json`, `$defs.releaseAuthorization`, in governance). Of the eleven governance registry entries, only sampleapp has one: "Standing deploy authorization for assigned changes to sampleapp's own target", source `deploy/AGENTS.md` (`registry/projects/sampleapp.json` in governance). It names no destination list, change classes, expiry or kill switch in machine-readable form.

### 2.4 Two facts that shape the release role

- **Workers inherit the supervisor's environment.** `workerEnv` copies every inherited variable except Claude Code session variables (`src/supervisor/proc.mjs:29-36`), and the runner uses it (`src/supervisor/runner.mjs:50`). So any credential placed in the supervisor's environment would reach every worker.
- **The supervisor uses the owner's existing `gh` login.** "No GitHub Actions, no new identity" (`github.mjs:1-2`). That login can technically merge today; only the rule and the absence of a merge call stop it. A release credential must therefore be a **different** identity, never loaded into the supervisor's or a worker's environment.

## 3. The two modes

| | Review only | Auto Release |
| --- | --- | --- |
| Default | Yes, for every project and destination | No |
| Needs a grant | No | Yes: a valid release authorization record (section 4) |
| Needs AW-008 accepted | No | Yes (section 10.1) |
| Needs the release role installed | No | Yes (section 6) |
| After a checked result | Publish and stop with a truthful next step (today's behaviour) | Run the eligibility check (section 5), then release (section 7) |
| Switching to it | Always allowed, immediate, from the dashboard or the CLI | Only by a new grant |

Rules:

- The mode is per **project and destination**, not per campaign. A campaign's approval preview shows which mode applies ([plan §3.2](../PROJECT_WORKSPACE_PLAN.md#32-work-request---one-authorization-autonomous-execution-inside-its-scope-owner-approved-d3)), but approving a campaign never turns Auto Release on. An approval for running code or adding child tasks is not a release permission (#13).
- Narrowing is always free: switching to Review only, pressing the kill switch, or letting a grant expire needs nobody's approval and takes effect before the next release step.
- Widening always needs a new grant version: a new destination, change class, environment or longer expiry.
- With Auto Release unavailable for any reason (no grant, expired, revoked, kill switch, release role not installed, `release.enabled` false), the project behaves exactly as Review only. Nothing else in the supervisor changes. This is the "mode OFF means exactly today" acceptance of #13.

## 4. The standing release authorization record

### 4.1 Where it lives

governance-029 says a standing deploy authorization is "recorded in the project". So the record lives **in the target project**, and the governance contract's registry points to it:

- **GitHub-backed project:** a JSON file in the project's repository, on its base branch, for example `release/aiworks-release.json`. the governance contract's registry entry names it in `releaseAuthorization` (the proposed `record` field, section 10.2). AIWorks reads it from the **base branch head fetched at evaluation time**, records the commit SHA and the file's sha256, and binds every release to that digest. A grant on an unmerged branch does not count.
- **Local-only project** (D1): the record lives in the owner-approved local project overlay that D2 will define ([plan §3.1](../PROJECT_WORKSPACE_PLAN.md#31-project-connection---github-optional-owner-approved-d1-2026-10-12)). Until D2 is settled, a local-only project cannot hold a valid grant, so local Auto Release stays unavailable. Local apply in Review only (an explicit owner "Apply" click) does not need a grant and is part of #7.

The record holds no secrets. Since 2026-10-17 it names no credential at all (section 6, plan section 8 (i)).

### 4.2 Fields

All fields are required unless marked optional. An unknown field, a missing field or a value of the wrong type makes the record invalid, and an invalid record means Review only.

| Field | Meaning | Example |
| --- | --- | --- |
| `schema` | Record format version | `"aiworks-release-authorization/1"` |
| `project` | governance registry id of the project; must equal the entry that points here | `"sampleapp"` |
| `version` | Grant version, a positive integer that only goes up | `3` |
| `approval` | The owner's approval: a GitHub issue or PR URL (same form as the governance contract's `approval`) | `https://github.com/example-org/example-repository` |
| `grantedAt`, `expiresAt` | ISO dates. `expiresAt` is required and at most 90 days after `grantedAt` | `2026-11-01`, `2027-01-30` |
| `revoked` | `true` stops the grant at once; a revoked version is never revived | `false` |
| `destinations[]` | One or more destinations, each with the fields below | |
| `destinations[].id` | Stable destination id | `"production"` |
| `destinations[].environment` | The governance environment name | `"production"` |
| `destinations[].kind` | `merge`, `merge-then-deploy`, `deploy`, `local-git-apply` or `local-folder-apply`. `deploy` (added 2026-10-17, plan (k)) deploys the merge commit the merge gate recorded and never merges; in a repository the merge gate covers, `merge` and `merge-then-deploy` are invalid | `"deploy"` |
| `destinations[].baseBranch` | For `merge` kinds: the only branch that may be merged into | `"main"` |
| `destinations[].mergeMethod` | For `merge` kinds: `merge`, `squash` or `rebase` | `"squash"` |
| `destinations[].changeClasses[]` | The classes this destination accepts (4.3) | `["docs", "app-code"]` |
| `destinations[].commands` | For deploy and local kinds: paths in the project to its own `deploy`, `observe`, `check` and `rollback` commands (4.4) | `{ "deploy": "deploy/release.ps1", ... }` |
| `destinations[].credential` | **Removed 2026-10-17** (plan (i)): a release uses the logins already on this computer (section 6). The REL1 schema still requires it; REL5a drops it | none |
| `destinations[].rollback` | `automatic` or `report-only`; `automatic` needs a `rollback` command and a retained previous artifact | `"automatic"` |
| `destinations[].checkWindowMinutes` | How long post-release checks may take before the result counts as failed | `10` |
| `classes` | The path rules that put a changed file in a class (4.3) | |
| `ownerConfirm[]` | Optional. Classes that may be prepared but always wait for the owner, even if listed above | `["dependency-update"]` |

### 4.3 Change classes

A release is allowed only when **every** changed file between the base and the candidate falls in a class the destination accepts.

- The project declares path rules: `classes: { "docs": ["docs/**", "*.md"], "app-code": ["src/**"], "migration": ["db/migrations/**"], ... }`. Rules are glob patterns over repository paths.
- A file matched by no rule is `unclassified`. `unclassified` blocks.
- A file matched by two rules takes the **stricter** class, in this order (strictest first): `migration`, `infrastructure`, `permissions`, `dependency-update`, `app-code`, `tests`, `docs`.
- These classes can **never** be accepted by an AIWorks grant in this version, whatever the record says: `migration`, `infrastructure`, `permissions`. A record that lists one is invalid. They are the plan's "irreversible migrations, new recurring spend, new environments/permissions" ([plan §5.5](../PROJECT_WORKSPACE_PLAN.md#55-separate-auto-release-mode-owner-approved-d5-tracked-13)) and stay with the owner-reserved gates (governance Constitution §2). Widening this list later is an AW decision, not a record change.
- Classification is deterministic code over `git diff --name-status base..candidate`. No model decides a class.

### 4.4 Project commands

AIWorks does not invent how a project deploys. The project names its own commands, at paths in its own repository, and they run at the **exact candidate revision** in a clean, detached release checkout:

| Command | Must do | Exit codes |
| --- | --- | --- |
| `deploy` | Deploy that exact revision and print the artifact digest it deployed | 0 done; non-zero failed |
| `observe` | **Read-only.** Print the revision and artifact digest live at the destination | 0 with output; non-zero means unknown |
| `check` | Read-only post-release checks (health, journeys) | 0 passed; 1 failed; anything else unknown |
| `rollback` | Restore the retained previous artifact and print its digest | 0 done; non-zero failed |

A `merge-then-deploy` destination without an `observe` command is invalid: without a read-only way to see what is live, a restart could not reconcile, and section 8 forbids guessing. governance already requires a named revision, artifact digest, drift check and retained rollback artifact for every release (Delivery Practices, artifact identity); these commands are how a project supplies that evidence to AIWorks.

### 4.5 The kill switches

Three independent ways to stop, each checked before **every** release step, not only at the start:

1. **Everything:** a file `RELEASE-STOP` in the supervisor data directory. Its presence stops every release on the machine. It works without the dashboard, without SQLite and without the release code being healthy, the same way `STOP` already stops the supervisor (`scripts/supervisor/deploy.ps1:22-23`). The dashboard and CLI offer "Stop all releases", which writes it. Removing it is an owner action.
2. **One project:** setting the project's mode to Review only in the dashboard or CLI. Stored in SQLite, applied before the next step.
3. **One grant:** `revoked: true`, a lower or missing record, or `expiresAt` in the past.

`release.enabled` in the supervisor's `config.json` is a fourth, build-level switch. It defaults to `false`, and every slice in section 11 ships with it `false`.

Stopping never interrupts a step that is already running in the middle (a half-run deploy is worse than a finished one). It prevents the **next** step. If a stop arrives after deploy and before checks, the checks still run and rollback still happens on failure: stopping releases must not stop recovery.

## 5. Eligibility of one exact verified revision

The eligibility evaluator is deterministic code. It takes one candidate (project, destination, task, `verified_sha`) and returns **eligible** or **not eligible, because ...** with one plain reason per failed check. Every check needs positive evidence. **Missing, unreadable, stale or unknown evidence fails the check.** There is no "assume yes".

| # | Check | Evidence that passes | Fails when (examples) |
| --- | --- | --- | --- |
| E1 | Auto Release is on for this destination | `release.enabled` true; no `RELEASE-STOP`; project mode is Auto Release | Any switch off; config unreadable |
| E2 | The grant is valid now | Record parses, matches schema, `project` matches, not revoked, `expiresAt` in the future, its digest is recorded | Record missing, invalid, expired, revoked; base branch fetch failed |
| E3 | The authority exists | AW-008 accepted in `docs/DECISIONS.md` of the running revision; the governance registry entry points to this record | Either missing |
| E4 | The candidate was independently checked | Task `done`; a verify operation with verdict `accepted` and `target_sha == verified_sha` (`controller.mjs:420`); its session differs from every implement session of the task | No accepted verify op for this exact SHA; same session |
| E5 | The candidate is the published one | GitHub: PR open, not draft, `headRefOid == verified_sha`, base equals `destinations[].baseBranch`. Local: staged revision equals `verified_sha` | Head moved, PR closed, read failed |
| E6 | The candidate is current | GitHub: the freshly fetched base head is an ancestor of `verified_sha`. Local: the target's baseline manifest equals the manifest the work started from, for every path the release writes or deletes | Base moved since verification; owner edited a file the release would overwrite |
| E7 | Every changed file is in an accepted class | Classification of `base..verified_sha` (4.3) is non-empty and every class is in `changeClasses` and not in `ownerConfirm` | `unclassified`, `migration`, a class not granted |
| E8 | Required project checks passed on this exact SHA | GitHub: every required status check on `verified_sha` is `success`. The project's release-preflight evidence, reviewed by the independent verifier, exists (RELEASE-001 `required_evidence`) | A check pending, failed or unreadable; preflight evidence absent |
| E9 | There is a way back | `merge`: always (revert, see 7.3). Deploy: `rollback` command present and `observe` reports a previous known-good digest. Local: free space for the backup and every target path readable | `observe` unknown; no previous artifact; backup impossible |
| E10 | Dependencies are released | Every task this one depends on is released to this destination, or the campaign declares it independent | A dependency only published |
| E11 | The destination is free | No other release holds the destination lock, and no release to this destination is in `unknown` | Lock held; an earlier release unresolved |
| E12 | The release role can act | The release role is installed and its credential reference resolves (presence only, value never read by AIWorks code outside the release process) | Credential missing |
| E13 | Nothing owner-reserved is touched | No class in E7 is owner-reserved; the candidate's report names no owner-reserved trigger | A worker reported `blocked-owner-reserved` on this task |

Rules around the table:

- The evaluator records the full input it used (record digest, PR snapshot, check results, classification) in the release row. A later step that finds any of it changed stops and re-evaluates; it does not carry an old "eligible" forward.
- Not eligible is not a failure of the work. The result stays published, the project behaves as Review only for it, and the owner view says why in one line, for example "Not released: `db/migrations/0042.sql` is a database migration. Release it yourself or ask for a grant."
- An E-check never asks the owner. If a missing piece only the owner can provide (E3, E12, a grant), the result simply stays in Review only, with that reason. This keeps to [AGENTS.md](../../AGENTS.md#owner-intervention): no new blocking gate on today's behaviour.

## 6. The release role

The release role is the governance `release-agent` role (`evaluate-release`, `deploy-eligible`, `rollback`; must not `deploy-ineligible`, `deploy-stale-sha`; registry/agents.json). In AIWorks it is **deterministic code, not a model**. Releasing needs no judgment that code cannot make from evidence, and a model would add cost and a new way to be wrong.

Separation from implementer and verifier:

- **Separate process.** The release step runs in its own short-lived process (`release-runner`), started by the controller with a **clean environment**: only `PATH`, `SystemRoot`, the release working directory and the variables the release step needs. It does not use `workerEnv`, which copies the supervisor's environment (`proc.mjs:33-36`).
- **No separate credential (owner answer to Q2, 2026-10-17, plan (i)).** The owner chose not to maintain release tokens. The release runner uses the logins already on this computer: the operator's `gh` login for a merge, as the merge gate does, and the project's own commands with the access they already have. Its clean environment gains only the variables those logins need to find themselves; it never sets `GH_TOKEN`. AIWorks creates, stores and renews no credential. The grant, checked in code before every step, is what limits a release to one repository and destination (slice REL5a).
- **No release credential for workers.** Implementer and verifier sessions keep today's deny list (`claude.mjs:67-71`), and in addition cannot reach the credential: it is not in their environment and they are not given the credential store reference. The supervisor's own `gh` login keeps doing only what AW-001 allows.
- **No release power in the controller code path.** The controller decides *that* a step is due and records the intent. Only the release runner holds the code that calls `gh pr merge`, the project's `deploy` or a local apply. A unit test asserts that no module other than the release adapters contains those calls.
- **Cannot release its own result.** The release role never produces content. E4 proves the verifier session is not an implementer session for this task. The release role cannot mark anything verified.
- **Audited.** Every step writes intent, command (without secrets), start, end, exit code and output digest to the journal and the release row.

Honest limit (observed, section 2.4): the owner's `gh` login on workstation can technically merge, and the deny list is a tool allowlist, not an operating-system sandbox. This design does not narrow that login. With the answer to Q2 a release also acts with that login, so GitHub cannot tell a release merge from any other merge by the owner; the journal and the release row can. What keeps a release to its repository is the grant check in code and the release-boundary test, not the credential's scope. Narrowing the login is a separate hardening question (not in this scope).

## 7. Releasing

### 7.1 State and the destination lock

Two new SQLite tables, additive, in the existing store (`store.mjs`):

- `releases`: one row per release attempt. Id and unique idempotency key `<project>.<destination>.<verified_sha>.<attempt>`. Holds the campaign and task, `verified_sha`, record version and digest, eligibility snapshot, merge commit, deployed and previous artifact digests, backup path, the current step, and a state.
- `release_locks`: primary key `<project>.<destination>`. Holds the release id, controller instance and lease generation.

States:

```
eligible -> locked -> merging -> merged -> deploying -> deployed -> checking -> accepted
                                    \__________ (merge-only) ______________/
                         applying -> applied -> checking                       (local kinds)
checking -> rolling-back -> rolled-back | rollback-failed
any step  -> unknown      (outcome not known; section 8)
before lock -> refused    (not eligible at the last moment)
```

Rules:

- **One release per destination at a time.** The lock row is taken in the same fenced transaction that moves the release to `locked`. A second candidate for the same destination waits; it is not an error.
- **A lock is released only at a known terminal state:** `accepted`, `rolled-back`, `refused`. A release in `unknown` or `rollback-failed` **keeps the lock**, so nothing else is released on top of an unknown destination.
- **Intent before effect.** Before each external step the release row records `step: <name>, started` and commits. After the step it records the outcome. A row with a started step and no outcome is, by definition, an unknown outcome (section 8).
- **Lease and fencing as today.** Release steps run under the campaign lease, like publication (`controller.mjs:813`). A takeover with a new generation reconciles before it acts.
- **Idempotency key per step.** Each step uses `<release id>.<step>` as its key. A step is never started twice for the same key; a retry after reconciliation gets a new attempt number and a new release id.

### 7.2 GitHub: merge, then deploy

1. **Re-check.** Re-run E1 to E13 inside the transaction that takes the lock. Any failure → `refused`, lock released.
2. **Merge.** `gh pr merge <n> --repo <repo> --<method> --match-head-commit <verified_sha>`, run by the release runner with the release credential. `--match-head-commit` makes GitHub refuse the merge if the head moved, so the exact checked SHA is the only one that can be merged.
3. **Confirm the merge.** Read the receipt with `integratedPullRequest` (`github.mjs:15-26`). Then fetch the base and check that the merge commit's tree equals `verified_sha`'s tree (`git rev-parse <merge>^{tree}` and `<verified_sha>^{tree}`). E6 makes this true for every merge method; if it is not, the merged code is not the checked code: state `merged`, deploy **refused**, owner told. Nothing is rolled back automatically, because nothing was deployed.
4. **Merge-only destinations stop here** and go to checks (step 7) with the project's merge checks, if any.
5. **Deploy.** In a clean detached release checkout at the merge commit, run `observe` (records the previous digest), then `deploy`. The deployed revision is the merge commit, whose tree is the verified tree.
6. **Confirm the deploy.** Run `observe`. It must report the merge commit and the digest `deploy` printed (the drift check of Delivery Practices). Anything else is `unknown` (section 8).
7. **Check.** Run `check` until it passes or `checkWindowMinutes` ends. A pass → `accepted`. A fail, or still unknown at the end of the window, counts as failed → rollback (7.4).

**In a repository the merge gate covers** (decided 2026-10-17, plan (k)): there is one merge path. The merge gate merges ([runbook](../SUPERVISOR.md#merge-gate)); the release role never calls merge there. A `deploy` destination starts at step 3 with the merge commit the gate journaled as `merged`, checks its tree against the verified tree, and continues with steps 5 to 7. No `merged` event means not eligible.

### 7.3 Rolling back a merge

A merge is not undone by force-pushing a branch. When a merge-only release fails its checks, AIWorks opens a **revert PR** for that merge commit through the ordinary supervisor flow, marks the release `rolled-back: revert proposed`, and tells the owner. The revert PR is itself a change: it is released only by an independent check and the same grant, never auto-merged on the strength of the failed release. A `merge-then-deploy` release rolls back the **deployment** (7.4); the merged code stays on the base branch and the revert follows as above.

### 7.4 Rolling back a deployment

- With `rollback: automatic`, a failed check runs the project's `rollback` command to the retained previous digest, then `observe` must report that digest, then `check` runs again. Pass → `rolled-back`. This is RELEASE-001 `automatic-rollback-where-safe`.
- With `rollback: report-only`, nothing is run; the owner is told at once and the lock stays held.
- **A failed rollback is an incident.** `rollback-failed` keeps the lock, stops every further release to that destination and goes to the owner immediately through the owner queue of #1 (governance Constitution §15: failed rollback).
- A rollback is never repeated blindly either: it follows the same intent-before-effect and reconciliation rules.

### 7.5 Local: apply with a reversible backup

There is no PR and no merge. The plan forbids fabricating either (`docs/PROJECT_WORKSPACE_PLAN.md:25`, `:106`). This needs the local project model of #7 and D2.

Since [AW-018](../DECISIONS.md#aw-018---merged-results-land-in-the-projects-own-folder), the same adapters also apply each checked local result outside Auto Release. AIWorks applies it once by itself, under `<data>/applies/`, as the owner's Apply would (`autoApply`, [runbook](../SUPERVISOR.md#project-folder)). It runs steps 1 to 4 below without E1 to E13: no grant, no release record and no project `check`. The rescan against the baseline manifest, the backup, the refusal over the owner's changes and Undo apply are unchanged. A GitHub project's own folder is only fast-forwarded to the merged base. Neither path is a release. Auto Release for a local destination still needs its grant, as below.

**Local Git** (`local-git-apply`), target: one named branch in the owner's repository.

1. Re-check E1 to E13. The owner's working tree must be clean and the branch head must equal the baseline commit the work started from.
2. **Backup:** write `refs/aiworks/release-backup/<release id>` at the current head. Record it.
3. **Apply:** fast-forward only: `git merge --ff-only <verified_sha>` on that branch. No merge commit, no rebase, no reset.
4. **Confirm:** branch head equals `verified_sha` and the tree is clean.
5. **Check:** the project's `check` command, if declared, in a clean detached checkout at `verified_sha` (never in the owner's working tree).
6. **Rollback:** only if the branch head still equals `verified_sha` and the tree is clean: move the branch back to the backup ref. Otherwise the owner has moved on: stop and tell the owner; never reset over their work.

**Plain folder** (`local-folder-apply`), target: the owner's source folder.

1. Re-check E1 to E13. For every path the release writes or deletes, the current file's sha256 must equal the baseline manifest. Symlinks, junctions, nested repositories and paths outside the folder are refused ([plan §3.1](../PROJECT_WORKSPACE_PLAN.md#31-project-connection---github-optional-owner-approved-d1-2026-10-12) local-folder write contract).
2. **Backup:** copy every file that will be changed or deleted into `<data>/releases/<release id>/backup/`, with a manifest of paths and hashes. Flush and record `backup-complete`. No apply before that record.
3. **Apply:** for each path, write to a temporary file in the same directory, flush, then rename over the target; delete removed files last. Record the target manifest (every path with its expected new hash, or "absent").
4. **Confirm:** every path matches the target manifest.
5. **Check and rollback** as for Local Git, restoring files from the backup only where the current hash still equals the target hash.

## 8. Restart: reconcile, never repeat

A controller crash, a takeover, a lost network or a killed release runner can leave a step started with no recorded outcome. The rule (Delivery Practices, no blind replay):

> **On restart, every release with a started step and no outcome is `unknown` until a read-only look at the destination proves where it is. AIWorks never runs the step again until that look proves the step did not happen.**

| Step left open | Read-only reconciliation | Proven done | Proven not done | Cannot tell |
| --- | --- | --- | --- | --- |
| merge | `gh pr view` via `integratedPullRequest`; fetch base | Record merge commit, continue at step 3 | PR open, head still `verified_sha`, base unchanged: merge may run again (GitHub cannot merge twice; `--match-head-commit` guards the head) | Stay `unknown`, keep the lock, retry the **read** with backoff |
| deploy | `observe` | Digest and revision equal the target: continue at checks | Previous digest still live: re-run `deploy` **only** if the record marks the command `idempotent: true`; otherwise stop and ask the owner | Stay `unknown`, keep the lock, retry `observe`; after the check window, tell the owner |
| check | Re-run `check` (read-only) | Pass → `accepted` | Fail → rollback | Counts as failed at the end of the window |
| rollback | `observe` | Previous digest live → `rolled-back` | Target still live: re-run `rollback` only if marked `idempotent: true`, else owner | `rollback-failed` path: incident |
| local-git apply | Branch head | Head = `verified_sha` → continue | Head = baseline → apply may run again | Any other head: stop, owner; never reset |
| local-folder apply | Hash every path in the target manifest | All target hashes → continue | All baseline hashes → apply may run again | Mixed baseline/target only: finish the remaining writes (each write's bytes are known and the backup is complete). Any **other** hash: someone else changed the file: stop, keep the backup, owner |

Further rules:

- A read failure is never evidence. "I could not read GitHub" is `unknown`, not "not merged".
- `unknown` keeps the destination lock, so no other release lands on top of it.
- The owner sees one line: "Release of `abc1234` to sampleapp production: outcome unknown since 14:05. AIWorks is checking the destination and will not deploy again until it knows." The **Stop** button still works while it reconciles.
- An `unknown` deploy is not by itself an incident. It becomes one under governance Constitution §15 when its checks show an outage that automatic recovery does not fix within 5 minutes, or when a rollback fails.

## 9. Owner view

Detailed screens belong to the #11 workspace design; this section only fixes what must be visible.

- **Project → Release mode:** one row per destination: mode, what the grant allows in one sentence (classes and destination), expiry date, credential owner, and one action ("Switch to Review only" or "How to grant Auto Release"). Auto Release is shown unavailable with its exact reason while any of section 3's conditions is missing.
- **Results:** the five steps of section 1 per result, each Yes / No / In progress / Unknown, with the exact SHA and links to the PR (GitHub) or the local revision (local).
- **Needs you:** only rollback failures, unknown outcomes past their window, and results that are not eligible because of an owner-reserved class. A result that is simply in Review only is a result, not a decision.
- **Stop all releases** is reachable from every project page and from the CLI (`supervisor release-stop`), and writes `RELEASE-STOP`.

Language follows D9 (English) and the plan's wording rules: "release", "merged", "live", "checked", "rolled back"; never "lease", "fencing" or "pipeline" on the primary screen.

## 10. Proposed authority changes (text only)

Nothing below is accepted. Each is the exact text proposed for the owner's review. AW-001 to AW-007 stay as written; the proposal adds AW-008 and a one-line cross-reference.

### 10.1 Proposed AIWorks decision AW-008

> **AW-008 - Auto Release is a separate release role under a standing per-project grant**
>
> Status: proposed (AIWorks design work). Narrows the scope of AW-001; does not replace it.
>
> AW-001 stays: the supervisor that runs campaigns never merges, deploys or changes provider resources.
>
> A separate **release role** may merge or deploy one result, or apply it to a local target, only when all of these hold:
>
> - the target project records a standing release authorization (governance-029) that names AIWorks, the destination, the change classes and an expiry, and it is valid, unexpired and not revoked;
> - an independent verifier accepted that exact revision;
> - every eligibility check in `docs/design/AUTO_RELEASE.md` section 5 passes on positive evidence;
> - the release role uses its own credential, which no implementer, verifier or coordinator process holds;
> - no `RELEASE-STOP` file exists and the project's mode is Auto Release.
>
> The release role never: releases a database migration, infrastructure or permission change, or anything adding recurring spend; releases to a destination or environment not in the grant; releases AIWorks into its own live runtime; repeats a step whose outcome is unknown. A failed rollback is an incident. Without a valid grant every project is in Review only, which is the behaviour of AW-001 alone.

Proposed one-line additions, also text only:

- `docs/DECISIONS.md`, under AW-001: "Scope narrowed by AW-008 for the separate release role."
- `docs/PRODUCT_CONSTITUTION.md:35`: append "The only exception is the separate release role of AW-008, under a standing per-project grant."
- `AGENTS.md:19`: append "The separate release role of AW-008 is the only exception."

### 10.2 Proposed governance provider changes

These are proposed for a governance pull request opened by the governance contract's own process, never from AIWorks. No governance constitution change is needed: §14 already allows a standing deploy authorization "limited to assigned changes and the project's own release targets", and AW-008 stays inside that.

1. **Schema** (`schemas/project-contract.schema.json`, `$defs.releaseAuthorization`): add two optional properties, keeping `additionalProperties: false`:

   ```json
   "executor": { "enum": ["owner", "aiworks"], "$comment": "Who runs the routine release under this grant. Absent means owner." },
   "record": { "$ref": "#/$defs/projectPath", "$comment": "Machine-readable standing release record (aiworks-release-authorization/1) in the project. Required when executor is aiworks." }
   ```

   Plus a conditional: when `executor` is `aiworks`, `record` is required.

2. **AIWorks registry entry** (`registry/projects/aiworks.json`): add a second exception next to `campaign-external-write`:

   ```json
   {
     "id": "release-executor",
     "rule": "constitution#14",
     "source": "AGENTS.md",
     "approval": "docs/DECISIONS.md#aw-008---auto-release-is-a-separate-release-role-under-a-standing-per-project-grant",
     "reviewBy": "<six months after acceptance>",
     "summary": "A separate AIWorks release role merges, deploys or applies a verified exact revision only under the target project's own standing release authorization naming AIWorks; never migrations, infrastructure, permissions or new spend."
   }
   ```

3. **Per project, when the owner grants it** (not now): the project's `releaseAuthorization` gains `"executor": "aiworks"` and `"record": "<path>"`, with `approval` pointing to the owner's grant issue. This is the owner's grant act for that project, made in that project's and the governance contract's own PRs.

## 11. Implementation slices

Each slice is one reviewable PR in `example-org/aiworks` unless marked. Tests are synthetic: temporary directories, disposable Git repositories, synthetic `gh` and project-command executables, as `tests/supervisor/helpers.mjs` does. No network, model or GitHub calls.

**Build switched off now:** R1 to R7 and R9. Every one ships with `release.enabled: false` and no release credential; with that default the full existing suite passes unchanged and no release can run.
**Wait for a decision:** R8 (D2), R10 (owner Q1), R11 (governance review and owner Q1), R12 (owner Q1, Q2, Q3).

**R1. Release authorization record: format and validator**

- Outcome: AIWorks can read and validate a standing release record and explain why one is invalid. Nothing acts on it.
- Files: new `schemas/release-authorization.schema.json`; new `src/supervisor/release/authorization.mjs` (load from a fetched base ref, validate, digest, expiry, revocation, forbidden classes); new `tests/supervisor/release-authorization.test.mjs`.
- Tests: `a valid record yields its digest and destinations`; `missing, unknown or mistyped fields are invalid`; `expired or revoked grants are invalid`; `migration, infrastructure or permissions in changeClasses make the record invalid`; `a deploy destination without observe is invalid`; `expiry beyond 90 days is invalid`.
- Acceptance: pure functions; no change to any existing test.
- Depends on: nothing.
- Waits for: nothing.

**R2. Eligibility evaluator, report-only**

- Outcome: for every `done` task, status reports "would be eligible" or "not eligible, because ..." per destination. It never acts.
- Files: new `src/supervisor/release/classify.mjs` (change classes from `git diff --name-status`), new `src/supervisor/release/eligibility.mjs` (E1 to E13 with injected readers), `src/supervisor/api.mjs` (a `release` field in status), new `tests/supervisor/release-eligibility.test.mjs`.
- Tests: one test per E-check proving it **fails on missing, unreadable and unknown evidence**, not only on a negative value; `an unmatched path is unclassified and blocks`; `the stricter class wins`; `same implement and verify session is not eligible`; `base moved since verification is not eligible`.
- Acceptance: evaluator makes no write and no external call except injected read-only readers; status for a campaign without a grant is unchanged except the new field saying "Review only".
- Depends on: R1.
- Waits for: nothing.

**R3. Release state and destination lock**

- Outcome: durable release rows, the per-destination lock, intent-before-effect and the reconciliation framework, driven by a fake adapter.
- Files: `src/supervisor/store.mjs` (additive `releases` and `release_locks` tables), new `src/supervisor/release/state.mjs` (state machine, lock, reconcile loop with adapter interface), new `tests/supervisor/release-state.test.mjs`.
- Tests: `two candidates for one destination never hold the lock together`; `unknown and rollback-failed keep the lock`; `a started step with no outcome is unknown after restart`; `an unknown step is reconciled before any action`; `a read failure is never treated as not done`; `takeover with a new generation reconciles first`.
- Acceptance: tables are additive; existing store tests pass unchanged.
- Depends on: nothing.
- Waits for: nothing.

**R4. Kill switches and mode**

- Outcome: `RELEASE-STOP`, per-project mode (default Review only) and `release.enabled` (default `false`), checked before every step; CLI `release-stop` and `release-mode <project> <destination> review-only`.
- Files: `src/supervisor/release/state.mjs`, `src/supervisor/cli.mjs`, `src/supervisor/api.mjs`, `docs/SUPERVISOR.md` (new release section, marked "built, not enabled"), new `tests/supervisor/release-switches.test.mjs`.
- Tests: `RELEASE-STOP stops the next step of every release`; `a stop after deploy still runs checks and rollback`; `switching to review-only needs no grant`; `release.enabled absent means off`.
- Acceptance: no command can switch a project **to** Auto Release; only a valid grant makes it available.
- Depends on: R3.
- Waits for: nothing.

**R5. Release runner: separate process and credential boundary**

- Outcome: a release step runs in its own process with a clean environment and fetches the credential by reference only for its command.
- Files: new `src/supervisor/release/runner.mjs`, new `src/supervisor/release/credential.mjs` (lookup by reference through an injected store; Windows Credential Manager adapter), new `tests/supervisor/release-runner.test.mjs`, a static test in `tests/supervisor/` asserting that `gh pr merge`, project `deploy` and local apply calls appear only under `src/supervisor/release/`.
- Tests: `the release runner's environment contains no supervisor variables`; `worker environments never contain the release credential`; `the credential never appears in the journal, row, log or packet` (synthetic credential string scanned for); `a missing credential makes E12 fail`.
- Acceptance: with `release.enabled: false` the runner is never started.
- Depends on: R3, R4.
- Waits for: nothing to build. Using it waits for Q2.

**R6. GitHub merge adapter**

- Outcome: merge with `--match-head-commit`, merge confirmation with tree equality, merge reconciliation, and revert-PR proposal on failure.
- Files: new `src/supervisor/release/github-merge.mjs`, `src/supervisor/adapters/github.mjs` (a read-only `pullRequestState` beside `integratedPullRequest`), new `tests/supervisor/release-github.test.mjs` with a synthetic `gh` executable and a disposable bare repository.
- Tests: `head moved after eligibility: merge refused`; `killed after merge before record: restart adopts the merge, merges once`; `gh read fails after merge: stays unknown, never merges again`; `merge tree differs from verified tree: deploy refused`; `failed merge-only checks propose one revert PR`.
- Acceptance: the synthetic `gh` records every call; no test sees two merge calls for one release.
- Depends on: R2, R3, R5.
- Waits for: nothing to build. Running it on a real repository waits for R10, R11 and Q2.

**R7. Deploy, check and rollback through project commands**

- Outcome: `observe`, `deploy`, `check`, `rollback` run at the exact revision in a clean release checkout under runner containment, with drift check and automatic rollback.
- Files: new `src/supervisor/release/deploy.mjs`, new `tests/supervisor/release-deploy.test.mjs` with synthetic project command scripts in a disposable repository.
- Tests: `observe disagrees with deploy output: unknown, no second deploy`; `deploy killed midway: restart observes first`; `non-idempotent deploy proven not done: owner, not re-run`; `checks fail: automatic rollback restores the previous digest`; `rollback fails: incident, lock held`; `checks unknown past the window: rollback`.
- Acceptance: every command runs with a timeout and in the job containment the runner already uses; no command runs in the owner's working tree.
- Depends on: R5, R6.
- Waits for: nothing to build. Running it on a real destination waits for R10, R11, Q2 and Q3.

**R8. Local apply adapters**

- Outcome: `local-git-apply` and `local-folder-apply` with backup, apply, confirm, rollback and reconciliation.
- Files: new `src/supervisor/release/local-apply.mjs`, new `tests/supervisor/release-local.test.mjs` with temporary folders and disposable Git repositories.
- Tests: `owner edited a target file: refused, nothing written`; `killed midway through a folder apply: finishes only known writes`; `a file changed by someone else during apply: stop, backup kept`; `local git apply is fast-forward only and never resets owner work`; `symlink, junction and outside paths are refused`; `no PR or merge state is ever reported for a local project`.
- Acceptance: tests pass on Windows, none skipped there.
- Depends on: R3, R4; the local project model of #7.
- Waits for: **D2** (local governance identity, plan §8) before a local grant can be valid. The Review-only "Apply" click belongs to #7.

**R9. Owner view of release state**

- Outcome: the release-mode row, the five-step ladder per result, unknown and failure lines in Needs you, and **Stop all releases**.
- Files: `src/dashboard/supervisor.mjs`, `src/dashboard/owner.mjs` (replace the display-only `releaseRule` wording when a record exists), `src/dashboard/public/` files owned by the #11 design at that time, `tests/dashboard/`.
- Tests: `unknown is never shown as success`; `a local project shows no PR or merge step`; `Auto Release shows its exact missing condition`; `Stop all releases writes RELEASE-STOP through the existing CSRF-checked command path`.
- Acceptance: blind owner review per UX-002.
- Depends on: R2, R4; the #11 workspace screens and their file owner (this slice does not edit those files while another campaign owns them).
- Waits for: nothing owner-reserved.

**R10. Record AW-008** (documentation)

- Outcome: AW-008 and the three one-line cross-references of section 10.1 are merged.
- Files: `docs/DECISIONS.md`, `docs/PRODUCT_CONSTITUTION.md`, `AGENTS.md`, `docs/STATUS.md`.
- Tests: `npm run check`.
- Acceptance: the text matches the owner's accepted wording.
- Depends on: nothing.
- Waits for: **owner Q1**.

**R11. governance provider schema and AIWorks exception** (governance pull request, by the governance contract's process)

- Outcome: the governance contract's schema accepts `executor` and `record`; AIWorks's registry entry carries `release-executor`.
- Files (in `example-org/governance`): `schemas/project-contract.schema.json`, `registry/projects/aiworks.json`.
- Tests: the governance contract's own registry and schema validation.
- Acceptance: governance review merges it; AIWorks reads it from the governance checkout (`docs/SUPERVISOR.md:230`).
- Depends on: R10.
- Waits for: **governance provider review** and owner Q1.

**R12. Disposable rehearsal, then a canary** (runbook, no new code)

- Built (first half): the disposable rehearsal is `scripts/supervisor/release-rehearsal.mjs` over `src/supervisor/release/rehearsal.mjs`, run in the suite by `tests/supervisor/release-rehearsal.test.mjs`, on a synthetic repository and site folder rather than on workstation ([runbook section 12](../SUPERVISOR.md#12-auto-release-built-not-enabled)). The canary still waits for the owner's grant.

- Outcome: on workstation, a full release cycle on a disposable destination, then one granted canary.
- Files: `docs/SUPERVISOR.md` (enablement and rollback: delete the grant or write `RELEASE-STOP`), `docs/STATUS.md`.
- Tests: the full suite at the deployed SHA; then, on a disposable repository and a disposable local folder: release, forced check failure with rollback, controller killed mid-merge and mid-deploy with reconciliation. Status before and after per [AGENTS.md](../../AGENTS.md#review-and-runtime-maintenance).
- Acceptance: observed on workstation and labelled verified only there: one merge per release, no deploy over an unknown state, rollback restores the previous digest.
- Depends on: R1 to R7, R10, R11 merged and deployed (R8 for a local canary, R9 recommended).
- Waits for: **owner Q1, Q2, Q3**.

## 12. Owner-reserved questions

Only these need the owner. Everything else above is decided under existing authority. D1, D3, D5 and D9 are settled and not asked again.

| # | Question | Why it is the owner's | Recommended answer | Unblocks |
| --- | --- | --- | --- | --- |
| Q1 | Accept AW-008 (section 10.1) as written? | It widens the supervisor's execution authority beyond AW-001 (governance Constitution §2: "security defaults that materially widen execution authority") | **Accept as written.** It keeps AW-001 for the supervisor, limits releases to per-project grants that expire, and excludes migrations, infrastructure, permissions and new spend. Default if unanswered: Review only everywhere, as today. | R10, R11, R12 |
| Q2 | Which identity does the release role use on GitHub? | Third-party account and credential ownership is owner-reserved (§2); only the owner can create it | **One fine-grained personal access token per granted repository**, owned by the owner's account, with only `contents: write` and `pull_requests: write` on that one repository, 90-day expiry matching the grant, stored in Windows Credential Manager as `aiworks-release/<project>`. A GitHub App is cleaner but needs a new app registration; start with the token. Default: none, so Auto Release stays unavailable. | Running R5 to R7 on a real repository; R12 |
| Q3 | Which destination is the first canary? | Granting a project a standing release authorization is the owner's act (governance-029) | **First a disposable repository and folder for the rehearsal; then `merge` (not deploy) of `docs` and `tests` changes to `example-org/aiworks` `main`**, a 30-day grant. Merges of verified AIWorks PRs are already not an owner stop for agents (`AGENTS.md:55`), deployment of AIWorks stays manual, and nothing reaches a production user. A deploy canary on sampleapp follows only after that has run cleanly. | R12 |

**Answered 2026-10-17** ([#33](https://github.com/example-org/aiworks/issues/33), plan section 8 (h) to (k)):

- **Q1:** accepted. REL9 records it under the next free number (AW-010 at that revision).
- **Q2:** no release token. The owner said: "do it easier. I don't want to watch after tokens now". A release uses the logins already on this computer (section 6).
- **Q3:** the disposable rehearsal first; then a 30-day grant for one owner project's production destination, `docs` and `tests` changes only; `app-code` only through a newer grant after those ran cleanly. The merge-only canary on AIWorks's `main` is dropped, because the merge gate (#138) already merges every verified AIWorks campaign PR.

Decided here, not asked (engineering decisions under existing authority):

- Maximum grant length 90 days; expiry is required.
- Migrations, infrastructure, permissions and new-spend changes are never in an AIWorks grant in this version.
- The release role is deterministic code, not a model.
- Merge uses `--match-head-commit` and a tree-equality check; a merge is undone by a revert PR, never a force-push.
- A deploy destination without a read-only `observe` command cannot be granted.
- Unknown check results at the end of the window count as failed and trigger rollback where rollback is automatic.
- AIWorks never auto-releases into its own live runtime.
