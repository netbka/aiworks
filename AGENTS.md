# Agent rules

## What this repository is

AIWorks is the owner's AI delivery machine: the delivery supervisor (with the coordinator, the executors and the Windows process containment), the operations dashboard, the campaign declarations and the worker-context runtime. Purpose and goals: [docs/PRODUCT_CONSTITUTION.md](docs/PRODUCT_CONSTITUTION.md). The reading list is in [README.md](README.md#start-here), and current state is in [docs/STATUS.md](docs/STATUS.md).

AIWorks is a registered project of [Engineering Platform](https://github.com/netbka/engineering-platform) (EP). EP's portfolio rules apply to agent work here and are not repeated in this repository:

- [Constitution](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md);
- [Agent Operating Model](https://github.com/netbka/engineering-platform/blob/main/docs/AGENT_OPERATING_MODEL.md);
- [Continuation](https://github.com/netbka/engineering-platform/blob/main/docs/CONTINUATION.md);
- [Owner Intervention](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md);
- [AGENT-001](https://github.com/netbka/engineering-platform/blob/main/policies/AGENT-001.json).

AIWorks reads EP's registry, policies and schemas from a read-only governance checkout ([docs/SUPERVISOR.md §6](docs/SUPERVISOR.md#6-running-on-homepc)). Changes to EP go through EP's own pull requests, never from here.

## The external-write exception (AW-001)

The supervisor's runtime has one exception ([AW-001](docs/DECISIONS.md#aw-001---the-delivery-supervisor-is-the-one-external-write-exception)). For a campaign the owner explicitly registered, the supervisor may create worktrees, campaign branches, PRs and issue comments in that campaign's target repository. It never merges, deploys or changes provider resources.

Agent work in this repository itself is bound by the rules below.

## What agents may do here

- change the supervisor, dashboard, worker-context runtime, scripts, tests and documentation of this repository;
- add or change campaign declarations in `campaigns/`. A campaign runs only after the owner registers it, from merged code and a declaration on main ([AW-005](docs/DECISIONS.md#aw-005---campaigns-run-only-from-merged-supervisor-code-and-a-declaration-on-main));
- report uncertainty explicitly.

## Agents must not

- change another project from agent work here (the supervisor's AW-001 writes for registered campaigns are the only exception);
- write to the governance checkout or change EP's governance from here;
- deploy, restart or reconfigure production;
- create/change DNS, OAuth, payment, Search Console or other provider resources;
- print, copy or store secret values;
- open .env or secret files when variable names/contracts are sufficient;
- widen an execution grant (for example Local Commander's, or a worker's tool isolation) without an owner decision ([Constitution §2](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md#2-owner-role), [§9](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md#9-security-boundaries-do-not-weaken-for-convenience));
- weaken any other security control;
- treat an inferred dependency as verified.

These rules apply in every phase.

## When to stop for the owner

AIWorks should deliver an authorized outcome end to end without the owner. EP's [Owner Intervention](https://github.com/netbka/engineering-platform/blob/main/docs/OWNER_INTERVENTION.md) contract classifies blockers; this section applies it here. It follows Dyk's stopper rule ([Dyk `AGENTS.md` §4](https://github.com/netbka/Dyk/blob/main/AGENTS.md#4-autonomy---act-unless-material-judgment-is-required)).

Ask the owner only for:

- an owner-reserved matter ([Constitution §2](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md#2-owner-role)). Raise it as one `owner-reserved` issue with the options, a recommendation and a default that keeps current behaviour. Keep doing other work meanwhile. Silence keeps the default;
- a destructive or hard-to-reverse action that is not already authorized;
- access that only the owner can grant, after the allowed alternatives have failed.

These are not owner stops in AIWorks. Decide them under existing authority and continue:

- merging a PR that passed the supervisor's independent verification of its exact head (owner decision 2026-10-12, [#17](https://github.com/netbka/aiworks/issues/17));
- declaring campaigns for an outcome the owner already authorized. The declaration only turns that authorization into campaigns;
- provider limits, such as a usage limit or rate limit with a reset. Wait or fall back, then resume;
- one failing tool or provider. Retry, or use another allowed route;
- file overlap with another task. Wait for it or sequence the work.

Never add a new blocking gate, lock, required approval or check that depends on something only the owner can provide (keys, credentials, accounts, provisioning or a new owner step), unless the owner approved that gate. Ship such hardening in report-only mode and raise one `owner-reserved` issue. Existing accepted gates (tests, independent review, deploy rules) still apply.

Prove a blocker before pausing: the exact failing step, what was tried, why you cannot resolve it, and who can ([Prove the blocker](https://github.com/netbka/engineering-platform/blob/main/docs/DELIVERY_PRACTICES.md#prove-the-blocker)). Every unjustified interruption of the owner gets an issue, so the routing gap gets fixed ([Unjustified interruptions](https://github.com/netbka/engineering-platform/blob/main/docs/DELIVERY_PRACTICES.md#unjustified-interruptions)).

## Changing the supervisor

- A change to `src/supervisor` needs an independent review that approves the exact head commit before merge. A green check alone is not enough. A merged PR is not proof of review: look for the approval on that exact SHA.
- The supervisor's independent verification of the exact head counts as that review (owner decision 2026-10-12, [#17](https://github.com/netbka/aiworks/issues/17)).
- Merging does not change what runs. The live runtime changes only through the upgrade procedure below.

## Upgrading the live runtime

The supervisor and dashboard run from the detached checkout `.local/runtime` on HomePc. The full procedure is in [docs/SUPERVISOR.md §6](docs/SUPERVISOR.md#6-running-on-homepc). In short:

1. Record `status` for every campaign that is not finished.
2. Pause those campaigns, and wait until no operation is open.
3. Deploy the exact hash printed by `git rev-parse origin/main` with `scripts/supervisor/deploy.ps1 -Sha <hash>`. Never type a hash by hand.
4. Resume each campaign with `start` of its identical declaration.
5. Run `status` again and compare. Only the controller revision and lease generation should change.

Only one session restarts the live runtime at a time. Agree it with any other session working on this machine first.

## Campaign declaration branches

Never name a branch `campaign/<campaignId>` in a target repository. The supervisor pushes task branches named `campaign/<campaignId>/<taskId>`, and Git cannot hold both, so every dispatch would fail with "cannot lock ref". Name declaration branches `declare/<campaignId>`.

## Secret rule

Store only secret **names/references and ownership metadata** here. Secret values belong in Infisical or the owner's human password manager. The supervisor's local `config.json` holds executable paths and repository paths, never credentials.

## Evidence rule

Every claim about the running system is one of:

- observed - directly found in code/config/docs;
- verified - checked against the actual provider/runtime;
- planned - target architecture only;
- unknown - not yet checked.

Do not silently promote observed or planned state to verified. A merged change is not a deployed one, and a deployed one is not proof that it works.

Accepted decisions are not "planned" merely because implementation is pending. Distinguish **decision authority** from **implementation state**. Status belongs in [docs/STATUS.md](docs/STATUS.md) and GitHub, not in normative documents.

## Validation

After changing code, schemas, campaign declarations, fixtures or documentation, run `npm install` once and then `npm run check`.
