# Executor bake-off (AIWorks native vs third-party runner)

Tracking: [#193](https://github.com/netbka/aiworks/issues/193). This document is a **test protocol**, not evidence of a successful integration. Do not merge an experimental executor into production as part of this experiment.

## Question and decision

Would delegating **only child-process execution** to a maintained third-party component reduce owner interventions or maintenance, while preserving AIWorks's exact-revision verification, durable authority and safety?

- A: AIWorks controller + existing native executor.
- B: the same AIWorks controller + Claudexor executor bridge.
- C (conditional): Sandcastle instead of B, only if Claudexor cannot pass E0.
- Crewly is evaluated separately as a *whole product* and cannot be pooled with the A/B result.

AIWorks owns authorization, planning, task identity, scheduling, verifier, acceptance, publication, application and release. A child runner may launch, observe, stop and return artifacts. **One** party owns dispatch idempotency, retries and unknown-process reconciliation at each interface. An accepted tool reply is not proof of process termination.

## E0: Feasibility before installing anything

1. Record baseline source SHA and, independently, installed runtime SHA, if observable. Document enabled features rather than assuming merged code is active.
2. Pin a Claudexor commit and license version. Inspect its Windows execution path, API, session persistence, process custody, cancellation, sandbox boundaries, credential handling, logging and commercial reuse restrictions.
3. Produce an interface mapping for `launch(runId, worktree, command, limits)`, `observe(runId)`, `cancel(runId)`, `collect(runId)`, and `reconcile(runId)`; identify unsupported operations.
4. Run a trivial no-network, no-secret command in a disposable environment. Do not install unreviewed third-party binaries globally, reuse operator sessions, mount credentials or alter the running supervisor.
5. Stop if safe isolation or a reliable Windows interface is not available. Document blocker; then evaluate Sandcastle using the same gate.

A source-level claim of Windows support is **not** a successful E0 run. A process spawned in an isolated environment must not be confused with a host process. No production migration is authorized.

## Reproduce synthetic fixture baselines

From the repository root, on a machine with Node.js and Git installed:

```sh
node experiments/executor-bakeoff/create-fixtures.mjs ./tmp-executor-fixtures
cd tmp-executor-fixtures/BUG-1 && node --test
cd ../FEATURE-1 && node --test
```

Both baseline test suites are **expected to fail**: they are tasks for the coding agents to fix. The generator refuses to overwrite existing fixture directories. Run each benchmark repetition from a fresh copy of the generated baseline commit, not the same mutated working directory. These fixture tests are not part of AIWorks's own green test suite.

## E1: Identical ordinary tasks

Two small **synthetic** fixture repositories, prepared at pinned commits:

**BUG-1:** `formatDuration(totalSeconds)` returns a readable `m:ss` string. The fixture has a failing case for seconds under 10; acceptance covers 0, 9, 10, 60 and 125 seconds and rejects non-integer/negative input. Prompt: "Fix the duration formatter without changing the public API. Run the fixture tests and report the exact changed files."

**FEATURE-1:** A minimal todo service supports `GET /tasks`; request a `POST /tasks` endpoint that validates a non-empty title, creates a unique ID, and returns the new task. Acceptance covers malformed JSON, missing/blank titles, two distinct creates, GET reflecting both and no change to the GET response contract. Prompt: "Implement task creation for the existing tiny service, keep the existing GET behavior, and run acceptance tests."

For each fixture, each variant receives three fresh copies of **the same** initial commit and identical prompt, model, CLI, account alias, permission mode, limits and verifier. This is 12 ordinary runs. Do not let variant B invoke its own unmeasured review or release. Compare accepted outcomes, not mere commits.

## E2: Controlled failure runs (separate from E1)

| ID | Injection | Expected invariant |
| --- | --- | --- |
| F1 | Verifier rejects an incorrect output | Corrective run, new independent verification of the new exact SHA |
| F2 | Transport response lost after dispatch accepted | Stable run ID, no second child, eventual reconciliation |
| F3 | Controller restarts while child remains active | Process custody is established before retry; unknown != stopped |
| F4 | Cancellation while child runs | Do not report stopped until process tree actually exits |
| F5 | Simulated quota/authorization failure | No busy-loop; no unauthorized account fallback |
| F6 | Source changed by owner after task start | Apply refuses conflicting changes and preserves owner data |

Run against disposable fixtures only. Never kill the live AIWorks service, touch another project's checkout, or run uncontrolled writes.

## Measurement contract

One JSON object per attempt in a **private** `runs.jsonl` file. No secrets, real project paths, hostnames or user data in public Git. Schema below is descriptive, not a claim of measured values.

```json
{
  "experimentVersion": 1,
  "fixture": "BUG-1",
  "variant": "native",
  "repetition": 1,
  "aiworksSha": "40-hex-git-sha",
  "runnerSha": null,
  "fixtureSha": "40-hex-git-sha",
  "agentCli": "claude",
  "model": "actual-provider-model",
  "accountAlias": "account-A",
  "startUtc": "ISO-8601",
  "endUtc": "ISO-8601",
  "durationMs": 0,
  "verifiedSha": null,
  "verifierVerdict": "unknown",
  "acceptancePassed": false,
  "retries": 0,
  "ownerInterventions": 0,
  "ownerMinutes": 0,
  "inputTokens": null,
  "outputTokens": null,
  "costUsd": null,
  "processCustody": "unknown",
  "duplicateSideEffects": false,
  "notes": ""
}
```

Use null for unknown usage and cost. Record every retry and verifier run in the outcome totals; do not treat subscriptions as an exact per-task dollar charge. Store stdout/stderr in private evidence, redact credentials and sensitive content. Publish only sanitized aggregates and source refs.

Report: every run, pass count by variant, median elapsed time, total owner interventions/minutes, retry counts, known token/cost totals and number of unknown receipts, hard-gate incidents, integration complexity (new files, dependencies, extra daemons, owned adapters removed). Explain differences rather than hiding failures in an average.

## Hard gates and decision

Any **observed** false success, wrong-SHA acceptance, duplicate side effect after replay, owner edit overwrite, false cancellation completion or cross-project/account access is a NO-GO until fixed and retested. These are safety/correctness gates, not weighted metrics.

If all hard gates pass, prefer B only when accepted quality is no worse and there is measured improvement in owner effort, time or a documented reduction in ongoing maintenance. If the gain is unclear, keep A. Do not promote an E0 feasibility success into an adoption decision. A conditional Sandcastle trial repeats E0-E2; Crewly requires a separate end-to-end owner journey.

## Status

- Protocol prepared; no benchmark result has been recorded in this document.
- Actual live runtime state is unknown until verified on the selected installation.
- No executor replacement, provider login change, global package installation, merge, deploy or release is part of this PR.
