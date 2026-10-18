# Development status

This document describes source capabilities only. Installation status, connected projects, campaign progress, machine names and private operational evidence belong outside the public repository.

The code includes a persistent SQLite-backed supervisor, bounded worker sessions, independent verification, ordered provider fallback, restart recovery, a coordinator inbox and a loopback dashboard. Executable runtime code must be merged before new work starts. Campaign declarations are private local data.

Coordinator plans and replies stay in the local dashboard. Requests retain their selected repository and run separately. Older pending coordinator replies are retained locally instead of published to GitHub. Registered campaign publication uses its declared target repository.

Code for sharing work between several logins of one provider through CAAM (choosing a login per run, launching the worker inside that login's own home folder, keeping a usage limit with its login, restart recovery and a rollback switch) is in the source, switched off. Synthetic tests verify it; no running supervisor uses it. Turning it on waits for the owner's pilot. See [SUPERVISOR.md section 13](SUPERVISOR.md#13-caam-account-profiles-built-not-enabled).

Project connection, work-envelope, adaptive scheduling, routing and release designs are in `docs/design/`. A design document is not proof that its feature is implemented, enabled or deployed. Release authorization records do not enable release execution.

Auto Release and cleanup after finished work are decided ([AW-010](DECISIONS.md#aw-010---auto-release-is-a-separate-release-role-under-a-standing-per-project-grant), owner decision 2026-10-17). Decided is not built or switched on:

- **Release (planned to switch on in REL11).** The source holds the release code built so far, switched off: reading a standing release record, the eligibility report, durable release rows with one lock per destination, the stop switches, the clean release process that uses the logins already on this computer, deploy, check and rollback through a project's own commands, and local apply with a backup. Synthetic tests cover it (observed in the source). `release.enabled` stays `false` and this repository holds no grant. Merged is not deployed: whether an installation runs this code is unknown here, and its own status says so. REL11 is the first slice that switches release on: a disposable rehearsal, then one granted canary.
- **Cleanup (planned to be built in CLN1 and switched on in CLN2).** No code removes a worktree or deletes a branch yet (observed in the source). CLN1 builds it switched off; CLN2 records a baseline and switches it on through the upgrade procedure.
- **AIWorks's own live runtime** is never a release destination. Its upgrades stay manual.

Waves that start by themselves are decided ([AW-011](DECISIONS.md#aw-011---the-next-wave-starts-by-itself-under-an-owner-approved-program-record), owner decision 2026-10-17). When a wave ends, AIWorks registers the next one from the plan, but only under one owner-approved program record and only when every slice fits it exactly. The source holds the program record store and the wave proposal and registration code built so far, switched off (observed in the source; see [SUPERVISOR.md section 14](SUPERVISOR.md#14-program-waves-built-not-enabled)). `program.enabled` stays absent, which means off, and this repository holds no program record. PROG5 is the slice that switches it on, with the owner's first program record (planned). Whether an installation runs this code is unknown here.

Use the selected installation's private status command and dashboard to verify its actual state. Never promote a repository test result into a claim about a live installation.
