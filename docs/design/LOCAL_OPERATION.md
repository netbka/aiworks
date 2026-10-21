# Design: AIWorks maintains itself without GitHub

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations, approval records, the work list's contents and the main ledger stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Status:** design only. Nothing here is built, enabled or deployed (planned). It designs the owner's decisions (e) and (f) of 2026-10-16 ([plan §8](../PROJECT_WORKSPACE_PLAN.md#8-owner-decisions-and-remaining-implementation-design-gates)), which the plan listed as gap G9. Its slices are lane SELF in [plan §6.8b](../PROJECT_WORKSPACE_PLAN.md#68b-lane-self---aiworks-maintains-itself-without-github). AW-001 to AW-007 stay as written until the slice that ships the behaviour lands the amended text of section 8.

**Basis:** observed code on main at `0634e2e`, 2026-10-16. Every `file:line` below points at that tree. What runs on the owner's computer is **unknown** here: merged is not deployed.

Refs #14.

## 1. What the owner gets

The owner said: "This AIworks should work with no dependency on Github." For AIWorks's own code and its own to-do list, that means:

- **Local main is the source of truth.** AIWorks merges its own verified work into `main` in the owner's checkout, on this computer. The rule does not get looser: it merges only a commit that an independent verifier accepted, only with a merge commit, and only when the result is exactly the tree the verifier checked.
- **The running AIWorks comes from local main.** New work starts only from code that is on trusted local main, and an upgrade installs the trusted tip of local main. A commit that slipped onto `main` some other way is not trusted until AIWorks or the owner records it.
- **GitHub becomes a backup.** If the owner switches it on, AIWorks pushes trusted `main` to GitHub after each merge. Nothing waits for that push. If GitHub is down or refuses, the dashboard says so and work carries on.
- **A local work list replaces GitHub issues.** Findings, owner decisions and review reports live in the dashboard. Workers read their task there, through a reader that shows them only their own items.
- **The open GitHub issues move once.** AIWorks copies them, with every comment, into the work list. Only after the owner confirms in the dashboard does it close them on GitHub, each with a short note naming its new local item.
- **Other projects are not changed by this.** A GitHub project keeps pull requests, merges on GitHub and issue comments. Projects without GitHub are covered by lanes STA and UI.

## 2. Where things stand today (observed)

| Area | Today | Evidence |
| --- | --- | --- |
| Trusted code | New work needs the runtime revision to be an ancestor of `refs/remotes/origin/main`. Without that ref, nothing new starts. | `src/supervisor/provenance.mjs:9`, `:15-27`; `src/supervisor/cli.mjs:191` |
| Merge gate | Merges a GitHub pull request by REST, with a merge commit at the verified SHA, after checking that the verified head contains the freshly fetched base. Candidates must have a GitHub pull request URL. | `src/supervisor/merge.mjs:66`, `:101`, `:150`, `:172`, `:200`; `src/supervisor/release/github-merge.mjs:14-19` |
| Publication | A verified commit is pushed to `origin` and opened as a pull request; a report becomes an issue comment; notes go to the tracking issue. | `src/supervisor/controller.mjs:2281-2284`, `:2308-2314`, `:2765-2772`, `:2790-2797` |
| Base reads | Every base is fetched from `origin` first. A new worktree starts from `origin/<base>`. | `src/supervisor/controller.mjs:1234-1239`; `src/supervisor/adapters/git.mjs:33-35` |
| Worker reads | Workers are told to read the task issue with `gh issue view`; Codex gets a GitHub MCP reader; research workers get a GitHub snapshot. | `src/supervisor/adapters/claude.mjs:177`, `:190`, `:198`; `src/supervisor/adapters/executors.mjs:271-275`; `src/supervisor/adapters/research-context.mjs:41-99` |
| Upgrade | `deploy.ps1` fetches `origin`, deploys `origin/main` and pulls the governance checkout; a failed pull stops the deploy. | `scripts/supervisor/deploy.ps1:19-20`, `:80-81` |
| Projects without GitHub | Their results already stay local (local candidates, no `gh`), but they cannot start yet (`LOCAL_START_OFF`). | `src/supervisor/controller.mjs:2229`, `:2356-2365`; `src/supervisor/campaign.mjs:357` |

The local-candidate path for projects without GitHub (WORK_ENVELOPE E10) is the model for this design: the result stays in the store and nothing calls GitHub. AIWorks itself is different in one way: the owner chose to have the merge gate merge into local `main` (decision (e)), not to review and Apply each result (decision (d), for other projects).

## 3. Every place AIWorks calls GitHub today

Grep basis: `gh`, `api.github.com` and `github.com` as words in `src/` and `scripts/`, plus every Git command that talks to the `origin` remote. Every hit is listed: 3.1 lists the calls that reach GitHub; 3.2 lists hits that make no call. "Stays" means the code stays for GitHub projects and is not used for AIWorks's own repository once its slice is on.

### 3.1 Calls that reach GitHub

| # | Area | Where | What it does | Slice that removes it or makes it optional |
| --- | --- | --- | --- | --- |
| G1 | `gh` command | `src/supervisor/controller.mjs:435` | Resolves the `gh` command every adapter call uses. | Stays; SELF1 pins the list of callers |
| G2 | REST adapter | `src/supervisor/adapters/github.mjs:1`, `:4`, `:14`, `:41-42` | `rest()` runs `gh api --include` and parses status, headers and rate limits. | Stays for GitHub projects; unused for AIWorks itself after SELF7 and SELF8 |
| G3 | Find a pull request | `src/supervisor/adapters/github.mjs:53-58` | `GET pulls?head=` | SELF7 (publication), SELF4 (CI repair is off for AIWorks itself) |
| G4 | Merge receipt | `src/supervisor/adapters/github.mjs:62-70` | `GET pulls/{n}`: was the pull request merged at the verified head? | SELF4 (the main ledger answers it) |
| G5 | Pull request state | `src/supervisor/adapters/github.mjs:72-80` | `GET pulls/{n}` for the merge gate | SELF8 |
| G6 | CI read | `src/supervisor/adapters/github.mjs:101-104` | `GET commits/{sha}/check-runs` | Off for AIWorks itself: there is no GitHub Actions run (owner decision 2026-10-13); SELF4 refuses `ciRepair` for the self-hosted repository |
| G7 | Open a pull request | `src/supervisor/adapters/github.mjs:106-133` (`:108`, `:112`, `:116`, `:121`, `:127`) | `POST pulls`, after a lookup | SELF7 |
| G8 | Find a marked comment | `src/supervisor/adapters/github.mjs:137-143` (`:138-139`, `:141`) | `gh api .../comments --paginate`, so a retry never posts twice | SELF7 |
| G9 | Post a comment | `src/supervisor/adapters/github.mjs:145-150` (`:147`) | `POST issues/{n}/comments` | SELF7 |
| G10 | Merge call | `src/supervisor/release/github-merge.mjs:3`, `:14-16` | `PUT pulls/{n}/merge`, `merge_method=merge`, `sha=<verified>` | SELF8 (local merge commit in `src/supervisor/release/local-merge.mjs`) |
| G11 | Merge gate | `src/supervisor/merge.mjs:66`, `:140`, `:150`, `:200`, `:249` | Selects candidates by GitHub pull request URL, reads the pull request, calls G10 | SELF8 |
| G12 | Dependency integration | `src/supervisor/controller.mjs:1224-1226` | Asks GitHub whether a dependency's pull request was merged | SELF4 |
| G13 | CI repair | `src/supervisor/controller.mjs:1381`, `:1383` | Reads CI and the open pull request of a published head | Off for AIWorks itself (G6) |
| G14 | Merged heads | `src/supervisor/controller.mjs:1554-1556` | Same receipt as G12, for published holders of work | SELF4 |
| G15 | Publication | `src/supervisor/controller.mjs:2253`, `:2264`, `:2267`, `:2283`, `:2286`, `:2289`, `:2296` | Repair push and comment, pull request, verification comment, report comment | SELF7 |
| G16 | Outbox | `src/supervisor/controller.mjs:2765-2772` (`:2768`), `:2790`, `:2795` | Tracking-issue notes (published, merged, blocked) | SELF7 |
| G17 | Worker availability | `src/supervisor/controller.mjs:1854`, `:2128`; `src/supervisor/adapters/executors.mjs:173`, `:195` | A Codex worker is unavailable without an absolute `gh` path for its reader | SELF6 (the work-list reader needs no `gh`) |
| G18 | GitHub MCP reader | `src/supervisor/controller.mjs:2139`; `src/supervisor/adapters/executors.mjs:238`, `:271-275`, `:287-290`; `src/supervisor/github-reader.mjs:19`, `:31`, `:45`, `:99` | Per-run read-only GitHub reader for workers | SELF6 |
| G19 | Worker prompts | `src/supervisor/adapters/claude.mjs:177`, `:190`, `:198` | "Read the task issue (`gh issue view …`)" | SELF6 |
| G20 | Research snapshot | `src/supervisor/controller.mjs:2121`; `src/supervisor/adapters/research-context.mjs:12`, `:42`, `:46`, `:58-60`, `:71-82`, `:91-99`, `:104` | Issues, pull requests, comments and pinned files read through `gh api` for brokered research | SELF6 (issues and comments from the work list; `readSources` of another repository keep GitHub and stay optional) |
| G21 | Coordinator | `src/supervisor/coordinator.mjs:83-84`, `:292`, `:294`, `:417` | Allows `gh issue/pr list/view`; tells the coordinator to inventory issues and PRs and to read other repositories through `gh`; passes `gh` to intake | SELF6 |
| G22 | Intake | `src/supervisor/intake.mjs:131-132`, `:149-152`, `:160`, `:172`, `:179` | Fetches the base from `origin`; reads an issue or a pull request with `gh api` | SELF4 (base), SELF6 (issue route reads the work list) |
| G23 | Project connect | `src/supervisor/project-connect.mjs:2-3`, `:36-37`, `:120-129`, `:154`, `:157`, `:164`, `:203`, `:207`, `:218`, `:243-246` | `gh auth status`, `GET repos/{repo}`, `git ls-remote origin` for a GitHub project | SELF4 (the self-hosted repository is checked without `gh` or `ls-remote`); stays for other GitHub projects |
| G24 | Worktree base | `src/supervisor/adapters/git.mjs:24`, `:33`, `:35` | `git fetch origin <base>`; worktree from `origin/<base>` | SELF4 |
| G25 | Push a verified commit | `src/supervisor/adapters/git.mjs:90-92` | `git push origin <sha>:refs/heads/<branch>`, then `ls-remote` | SELF7 (no push for the self-hosted repository) |
| G26 | Remote branches | `src/supervisor/adapters/git.mjs:102-103`; `src/supervisor/controller.mjs:1292` | `git ls-remote origin refs/heads/campaign/<id>/*` for integration checks | SELF4 (local branches) |
| G27 | Base fetch | `src/supervisor/controller.mjs:1234-1239`, `:1253`, `:1291`, `:1549`, `:2009`; `src/supervisor/merge.mjs:101` | `git fetch origin +refs/heads/<base>:refs/aiworks/base/<base>` | SELF4 |
| G28 | Trusted code | `src/supervisor/provenance.mjs:9`, `:20`, `:25-26`; `src/supervisor/cli.mjs:27`, `:108`, `:190-191`; `src/supervisor/controller.mjs:69`, `:377`, `:701`, `:715`, `:2559`; `src/supervisor/coordinator.mjs:24` | Ancestor of `origin/main`, a ref that only a fetch from GitHub updates | SELF3 |
| G29 | Dashboard Resume | `src/dashboard/supervisor.mjs:680`, `:704`; `src/dashboard/server.mjs:36` | The same check for Resume | UI19 |
| G30 | Dashboard merge check | `src/dashboard/merges.mjs:2`, `:134-142` | `git fetch origin` every 5 minutes while a page is open | UI19 (reads local `main` for the self-hosted repository) |
| G31 | Dashboard connect routes | `src/dashboard/projects.mjs:17`, `:336`, `:436`, `:458`; `src/dashboard/server.mjs:33` | Run G23 for a GitHub project | Stays; covered by SELF4 for the self-hosted repository |
| G32 | Deploy | `scripts/supervisor/deploy.ps1:6`, `:19-20` | `git fetch origin`, then `git rev-parse origin/main` | SELF12 |
| G33 | Governance refresh | `scripts/supervisor/deploy.ps1:80-81` | `git pull --ff-only` of the governance checkout; a failure stops the deploy | SELF12 (with local trust, a failed pull keeps the current checkout and warns) |

The governance reads themselves are local file reads of the governance checkout (`src/supervisor/campaign.mjs:468-507`, [SUPERVISOR.md §6](../SUPERVISOR.md#governance-checkout)): they need no network once the checkout exists. AIWorks's own registry entry is matched by its `repository.github` text, which stays valid offline.

### 3.2 Hits that make no call

| Where | What it is | Change |
| --- | --- | --- |
| `src/supervisor/adapters/claude.mjs:76-77`, `:91`; `src/supervisor/coordinator.mjs:71-72`, `:77-78`, `:88-91` | Deny lists and comments that forbid `gh` writes | None: they stay |
| `src/shared/credential-metadata.mjs:12`; `src/dashboard/roadmap.mjs:11` | GitHub token patterns for secret detection | None |
| `src/supervisor/project-preflight.mjs:4`, `:127-132`; `src/supervisor/projects.mjs:3`, `:45-46`, `:56`; `src/supervisor/project-connect.mjs:272`; `src/dashboard/roadmap.mjs:58` | Parse or validate a `github.com` remote; no call | None |
| `src/supervisor/campaign.mjs:114`, `:125` | A declaration's authorization must be a GitHub URL and its tracking issue a number | SELF7 (accepts `aiworks-work:<n>` for the self-hosted repository, switched on with STA17) |
| `src/supervisor/intake.mjs:272-274`, `:324` | Builds issue and pull request links; a stand-in URL for validation | SELF6 (work-item links for the self-hosted repository) |
| `src/supervisor/owner-intervention.mjs:94` | Blocker link to the tracking issue | SELF7 (tracking item link) |
| `src/dashboard/owner.mjs:33`; `src/dashboard/public/dashboard.js:730`; `src/dashboard/copy.mjs:573` | Fixed links to AIWorks's issue #2 and the runbook on GitHub | UI19 (links into the local work list and the local runbook text) |
| `src/dashboard/supervisor.mjs:258` | `gh` is one of the commands Diagnostics probes for presence | UI19 shows it as "not needed" when no project uses it |
| `src/dashboard/supervisor.mjs:491`, `:551`, `:565`, `:620-621`; `src/dashboard/roadmap.mjs:36` | Tracking-issue, task-issue, plan-source and roadmap links | UI19 (work-list routes for the self-hosted repository) |
| `scripts/run-tests.mjs:35` | The test runner's tier pattern names the `fake-gh` fixture | None |

## 4. Local main is the trusted source

### 4.1 The setting

One block in the data directory's `config.json`, absent by default:

```json
"selfHosting": {
  "repository": "example-org/aiworks",
  "trustedMain": "local",
  "backup": { "enabled": false, "remote": "origin", "branch": "main" }
}
```

- `repository` names AIWorks's own repository, as campaigns already name it in `target.repository`. Only that repository is affected. Every other project behaves exactly as today.
- `trustedMain` is `"origin"` (today's behaviour, the default) or `"local"`. A malformed block is off and logged, like `merges` (`src/supervisor/merge.mjs:24-39`).
- Declarations do not change, so no scope digest changes.

### 4.2 The main ledger

`refs/heads/main` is shared by every linked worktree of the repository, including worker worktrees. A worker that runs `git update-ref refs/heads/main <sha>` could move it. Today the same forgery of `refs/remotes/origin/main` is undone by the next fetch from GitHub; with local trust nothing would undo it. So "trusted local main" cannot simply mean "whatever `main` points at".

The supervisor keeps an append-only **main ledger** in its store (`main_ledger`: sequence, repository, old tip, new tip, kind, campaign, task, verified SHA, time). A row is written only by:

| Kind | Who | When |
| --- | --- | --- |
| `anchor` | The switch-on step (SELF13) | Once. The anchor must equal `refs/remotes/origin/main` after a fetch, and local `main` must equal it: trust passes from GitHub's main as it is at that moment, with no new root of trust. |
| `gate-merge` | The local merge gate (4.4) | For each merge commit it makes, in the same fenced transaction that records the merge. |
| `owner` | The owner, through a dashboard owner route with origin, CSRF and the caller check of [WORK_ENVELOPE §8](WORK_ENVELOPE.md#8-decision-d4-local-admission-without-github) | When the owner wants a commit they put on `main` by hand to be trusted. Optional: nothing waits on it (4.3). It binds the trusted tip and the local `main` the page showed, rechecks both in the transaction that appends the row, moves no ref, and refuses commits that change `src/supervisor/`, which still need an independent review. |

**The trusted tip** is the newest ledger commit that is still an ancestor of, or equal to, local `main`. Commits on `main` after it are **unrecorded**. If no ledger commit is still on `main` (main was rewound or rewritten), the state is `MAIN_REWRITTEN`.

### 4.3 Runtime provenance

With `trustedMain: "local"`, `revisionNotMerged` (`src/supervisor/provenance.mjs:15-27`) checks that the runtime revision is an ancestor of the trusted tip, not of `origin/main`. It still never fetches or changes a ref. Its refusals say "local main" and name the trusted tip. `MAIN_REWRITTEN` refuses all new work with a B2 blocker, as a missing `origin/main` does today (`src/supervisor/provenance.mjs:20`).

Unrecorded commits on `main` do not stop work. They are simply not trusted for the runtime until a recorded commit contains them. That is at least as strict as today: a runtime on an unrecorded commit is refused, exactly as a runtime ahead of `origin/main` is refused now.

The dashboard's Resume check (`src/dashboard/supervisor.mjs:704`) uses the same function and the same setting (UI19). The CLI gains `trusted-main`, which prints the trusted tip and the number of unrecorded commits, read-only, for `deploy.ps1`.

### 4.4 The local merge gate

The gate keeps every condition of [SUPERVISOR.md "Merge gate"](../SUPERVISOR.md#merge-gate) that does not name GitHub, and replaces the three that do. It is on only when the owner listed the repository in `merges.repositories` with `delegatedTo: "supervisor"` (as today) **and** `selfHosting.trustedMain` is `"local"`.

1. The repository is listed and the result is not held (`merges.held` takes a local review id as well as a URL).
2. The candidate is a commit task this campaign verified and recorded as a local review (section 5.2), its local branch `campaign/<campaign>/<task>` points at the verified SHA, and the campaign is neither paused nor cancelled.
3. **Verified tree.** The verified SHA contains the trusted tip (`git merge-base --is-ancestor <trusted> <verified>`). Otherwise the task goes back as an integration repair round, exactly as today (`src/supervisor/merge.mjs:171-176`).
4. **No unrecorded commits.** Local `main` equals the trusted tip. Otherwise the gate waits with the reason "main has N commits AIWorks did not put there", and Settings › Connections offers the owner route of 4.2. Running work is not held (4.3).
5. The operator's checkout that has `main` checked out, if any, has no local changes. Otherwise the gate waits: "your checkout has unsaved changes".
6. This runtime passes the AW-005 check of 4.3.

**The merge.** In `src/supervisor/release/local-merge.mjs` (the REL5 boundary keeps `--ff-only` and `update-ref` under `release/`):

1. Journal `merge-requested` with the trusted tip and the verified SHA.
2. `git commit-tree <verified>^{tree} -p <trusted> -p <verified>` with a message naming the task, the verified SHA and the campaign. This is a merge commit: two parents, the base first. It writes objects only.
3. Check that the new commit's tree equals the verified tree. If not, stop and journal `merge-refused`; nothing has moved.
4. Move `main` from the trusted tip to the new commit: if `main` is checked out in a clean worktree, `git merge --ff-only <new>` there, so the owner's files follow; otherwise `git update-ref refs/heads/main <new> <trusted>`, which fails if `main` moved in between. Never `-f`, never a `+` refspec, never another ref.
5. In one fenced transaction: the `gate-merge` ledger row and the `merged` journal entry.

**Crash safety.** After `merge-requested`, the next pass reads `main` first. If `main` is the planned merge commit (same parents, verified tree), it records it with `reconciled: true` and makes no second commit. If `main` is still the trusted tip, it tries again. Anything else waits with the reason. This mirrors today's "read the pull request before any retry" (`src/supervisor/merge.mjs:148-164`).

What stays exactly as strict: only an independently verified head merges; only with a merge commit; only when the merged tree is the verified tree; never a squash, a rebase, a force-push or a branch deletion; the gate is off by default and per repository.

### 4.5 Deploy and the upgrade procedure

With local trust, the upgrade procedure ([SUPERVISOR.md "Upgrade"](../SUPERVISOR.md#upgrade)) changes in step 3 only: the commit is the output of `node src/supervisor/cli.mjs trusted-main --data <data>`, never typed by hand and never raw `git rev-parse main`. `deploy.ps1 -Main local` takes it the same way when no `-Sha` is given, and refuses a `-Sha` that is not an ancestor of the trusted tip. It does not fetch.

The governance checkout is another project's repository. With local trust, a failed `git pull --ff-only` (`scripts/supervisor/deploy.ps1:80-81`) keeps the checkout at its current commit and writes a warning with that commit. Governance changes already take effect only once pulled ([SUPERVISOR.md §6](../SUPERVISOR.md#governance-checkout)), so this only removes the network from the deploy's critical path. With `trustedMain: "origin"`, the deploy behaves exactly as today.

### 4.6 GitHub as an optional backup

With `backup.enabled`, after each recorded local merge the supervisor runs `git push <remote> <trusted tip>:refs/heads/<branch>`: no `--force`, no `+`, no `--mirror`, bounded to 60 seconds, at most once every 10 minutes, and only the trusted tip, never unrecorded commits. The result goes to the journal (`backup-pushed`, `backup-refused` with Git's reason, `backup-failed`) and to status.

Nothing waits on it. A refusal, for example because branch protection on GitHub refuses direct pushes or someone merged on GitHub, is reported in Diagnostics with the reason and tried again after the next merge. It is never forced. The owner can point `branch` at another branch, such as `aiworks-backup/main`, if branch protection must stay.

## 5. The local work list

### 5.1 Items and comments

Two additive store tables:

- `work_items`: number, kind (`finding`, `decision`, `review`, `task`, `note`), title, body, state (`open`, `closed`), labels, `needs_owner`, links (campaign, task, verified SHA), source (for imported items: the GitHub URL and its `updated_at`), author kind (`owner`, `supervisor`, `import`), times.
- `work_item_comments`: append-only, with an idempotency key (the role today's comment marker plays, `src/supervisor/adapters/github.mjs:135`).

Numbers: imported issues keep their GitHub numbers, so `#14` stays `#14` and every existing `issue` and `trackingIssue` number in a declaration still points at the same item. New items are numbered after the highest GitHub issue or pull request number seen at import.

Text is bounded (1 MiB per body, larger than GitHub's 65,536 characters, so a verified report is never split) and passes the same credential check as coordinator replies (`src/shared/credential-metadata.mjs`). Only the owner route and the supervisor write items. Workers never write; a worker's report reaches the list only after independent verification, through publication.

### 5.2 Where reports and notes go

For the self-hosted repository with local trust:

| Today (GitHub) | Local work list |
| --- | --- |
| Verified commit: push, pull request (`src/supervisor/controller.mjs:2281-2284`) | A `review` item: the PR body text, the verified SHA, the local branch, and the verification. No push. |
| Verified report: issue comment (`src/supervisor/controller.mjs:2308-2314`) | A comment on the task's item, with its verification. |
| Repair heads: comment on the open PR (`src/supervisor/controller.mjs:2261-2268`) | A comment on the same `review` item. |
| Outbox notes: tracking-issue comments (`src/supervisor/controller.mjs:2765-2797`) | Comments on the tracking item. |
| Blockers: tracking-issue comment and link (`src/supervisor/owner-intervention.mjs:94`) | Comment and link to the tracking item; owner decisions also become `decision` items with `needs_owner`. |

**Review campaigns** (UX reviews, audits, any report task) record their reports in the same way: a report deliverable becomes a comment on its task's item. The coordinator's review answer already stays local ([AW-004](../DECISIONS.md#aw-004---the-coordinator-is-read-only)); its inventory of "issues and pull requests" (`src/supervisor/coordinator.mjs:292`) reads the work list and local review items instead.

A campaign for AIWorks itself may then name its owner authorization as `aiworks-work:<n>`, an item the owner created through the owner route. `src/supervisor/campaign.mjs:114` accepts that form only for the self-hosted repository with local trust, and only once STA17 has switched local admission on (6.3).

### 5.3 The scoped local reader

`src/supervisor/work-list-reader.mjs` is an MCP server shaped like the GitHub reader (`src/supervisor/github-reader.mjs`): one read tool, a scope check first, bounded pages, no write, and it stops after an upstream failure. Its scope is fixed when the run starts:

- the campaign's tracking item, the task's item, and items the packet's references name;
- for a reviewer or planning role only: titles and states of open items, so a review can inventory them.

It reads the store read-only. It needs no `gh` and no network, so Codex is no longer unavailable for want of an absolute `gh` path (`src/supervisor/adapters/executors.mjs:195`). Prompts for the self-hosted repository say "read item #N with the `aiworks_worklist` tool" instead of `gh issue view` (`src/supervisor/adapters/claude.mjs:177`, `:190`, `:198`). Prompts for every other repository are byte-identical.

### 5.4 The one-time import, and closing on GitHub

**Import** (`supervisor work-list import`, read-only towards GitHub). It reads every open issue (not pull requests) and all its comments with REST `GET`, paginated (`--paginate`; never GraphQL, #16 and #21). It writes items with the same numbers and their comments with author login and time. Running it again adds only new comments and reports changed bodies; it never duplicates. `--dry-run` is the default and prints the counts. Secret-like text is withheld and listed, as coordinator replies are.

**Closing**, only after the owner confirms. The dashboard shows the list of imported issues still open on GitHub. The owner confirms it with a typed confirmation, through an owner route with the caller check. For each issue on that list, in order:

1. If the issue changed on GitHub since the import (`updated_at`), skip it and report it.
2. Post one marked comment: "Moved to the AIWorks local work list as #n on <date>. Continue there." (no link: the dashboard is local).
3. `PATCH` the issue to `closed`, `state_reason: not_planned`.

A crash between 2 and 3 finds the marker and does not comment twice. Nothing outside the confirmed list is touched, and no label changes. This is a GitHub write outside a campaign, so it waits for the amended AW-001 (section 8) and ships with it.

## 6. Threats and the tests that answer them

| Threat | Answer | Test (slice) |
| --- | --- | --- |
| A worker moves `main` with `update-ref` or `branch -f` | The runtime trusts only the ledger's tip; the gate waits on unrecorded commits | Forged move from a synthetic worker worktree: runtime check unchanged, gate waits, nothing merged (SELF3, SELF8) |
| `main` rewound or rewritten | `MAIN_REWRITTEN` holds new work | Reset `main` below the anchor: B2 blocker (SELF3) |
| The merge puts an unverified tree on `main` | Ancestor check, then tree equality, before any ref moves | Base moved: repair, no merge; forced tree mismatch: `merge-refused`, `main` unchanged (SELF8) |
| Crash mid-merge | Journal intent first; read `main` before retry | Fault after `commit-tree` and after the ref move: exactly one merge commit (SELF8) |
| The owner's unsaved work is overwritten | Clean-checkout condition; `--ff-only` refuses otherwise | Dirty checkout: gate waits, files byte-identical (SELF8) |
| The backup push rewrites GitHub history | No force, no `+`; only the trusted tip | A diverged bare remote: `backup-refused`, remote unchanged (SELF9) |
| GitHub down stalls work | Nothing waits on the backup or the import | Unreachable remote: the next merge still happens (SELF9) |
| A worker reads another campaign's items | Scope fixed at run start | Out-of-scope number refused; identity first (SELF6) |
| Closing issues the owner did not confirm | Only the confirmed list, only unchanged issues, only from the owner route | Synthetic AIWorks caller refused; changed issue skipped (SELF11) |
| A new GitHub call appears unnoticed | Static boundary test | A planted `gh api` call outside the list fails with its `file:line` (SELF1) |

Every test uses disposable git repositories, synthetic `gh` (`tests/supervisor/fixtures/fake-gh.mjs`) and no network, as `tests/supervisor/helpers.mjs` does. A test that depends on Windows job objects (the caller check) skips elsewhere with the reason named.

## 7. Decisions taken here, and what waits

**Taken here (design choices, not owner-reserved):**

- **The main ledger and "unrecorded commits".** Without it, local trust would be weaker than today (4.2). Unrecorded commits block only the opt-in merge gate, never running work, so this adds no owner-dependent gate for work. The owner can record a hand-made commit at any time.
- **No branches on GitHub for AIWorks itself.** Publication stays local; the backup pushes `main` only. A reviewer who wants a GitHub view uses the backup.
- **Numbers carry over.** Imported issues keep their numbers so declarations stay valid with unchanged digests.
- **Closing uses `not_planned` and a link-free pointer.** The item was moved, not done; the dashboard has no public address.

**Waits for nobody but its dependencies:** every slice of lane SELF. Decisions (e) and (f) are the owner's (2026-10-16).

**Switched off until a named step:**

- The `aiworks-work:<n>` authorization reference ships off and switches on with STA17, which turns on local admission (decision (c)). The task packet for this design lists GitHub-free local admission as still open; plan §8 records it as decided on 2026-10-16. Either way nothing here enables it.
- Local trust, the local merge gate and the backup are off until SELF13 changes `config.json` through the upgrade procedure.
- Closing issues on GitHub happens once, only after the owner confirms the list in the dashboard (SELF11, UI20).
- Auto Release (#33) and Telegram (#1) are not touched.

## 8. Proposed amended text

These replace the current text when SELF12 lands, after SELF3 to SELF11, UI19 and UI20 are merged. Until then the current records bind. Links in the quoted text are written relative to this file; SELF12 writes them relative to the file they land in.

### 8.1 AW-001

> ## AW-001 - The delivery supervisor is the one external-write exception
>
> For a registered campaign, the supervisor may create worktrees and task branches and record verified results. For a target repository published through GitHub, it may push a verified task branch, open a pull request and post issue comments there. For AIWorks's own repository with local main trusted (AW-005), it records results, reports and notes in the local work list and makes no GitHub write for them. Workers do not publish directly. The supervisor never deploys, releases or changes provider resources.
>
> It merges only under the merge gate, and only when the owner opts in ([#138](https://github.com/example-org/aiworks/issues/138), owner decision 2026-10-14). The opt-in is `config.json` `merges.delegatedTo: "supervisor"` with an explicit list of repositories; it is off by default. It merges only when merging puts exactly the independently verified tree on the base branch, and only with a merge commit: never a squash, a rebase, a force-push, an admin bypass or a branch deletion. A GitHub pull request is merged by GitHub's merge call at the verified head. In AIWorks's own repository with local main trusted, the merge commit is made locally, with the trusted tip and the verified head as its parents and the verified tree as its tree; `main` moves to it only from the trusted tip, and the main ledger records it. The gate is in [the runbook](../SUPERVISOR.md#merge-gate).
>
> When the owner turns the backup on, the supervisor may push the trusted tip of local main to the configured GitHub branch, never with force; nothing waits on that push. Once, after the owner confirms the list in the dashboard, it may comment on and close the GitHub issues it imported into the local work list, each with a note naming its local item; it closes nothing else.

### 8.2 AW-005

> ## AW-005 - Runtime code must be merged; declarations remain private
>
> New execution and coordinator work require a runtime revision that is an ancestor of the trusted main. The trusted main is `origin/main`, unless the owner set `selfHosting.trustedMain: "local"` for AIWorks's own repository (owner decision 2026-10-16). Then it is the newest commit of the main ledger that is still on local `main`: a merge the merge gate made, the anchor recorded when local trust was switched on (equal to `origin/main` at that moment), or a commit the owner recorded through the dashboard's owner route. A commit on local `main` that none of these put there is not trusted until one does. An upgrade deploys the trusted main. Operator campaign files are local JSON data and are not committed. Explicit `start` reads and validates a private file; scope is immutable and amendments need a higher authorization version. Dashboard Resume uses the previously registered declaration with atomic version and authority checks. This supersedes any earlier requirement to commit declarations.

The verified-tree, merge-commit and merged-runtime rules keep their wording; only the place the trusted main lives is added.

### 8.3 AGENTS.md

- "Authorized work", second paragraph, becomes: "The supervisor may create isolated worktrees and campaign branches in a registered campaign's target repository. Where that repository publishes through GitHub it may open pull requests and post issue comments there; for AIWorks's own repository with local main trusted it records them in the local work list instead (AW-001). It merges only under the merge gate, when the owner opts in for that repository (AW-001, [the runbook](../SUPERVISOR.md#merge-gate)); it never squashes, rebases, force-pushes, bypasses branch protection or deletes a branch. It never deploys, releases or changes provider resources."
- "Review and runtime maintenance": "Deploy the exact reviewed revision from `git rev-parse origin/main`" becomes "Deploy the exact reviewed revision of the trusted main: `git rev-parse origin/main`, or `node src/supervisor/cli.mjs trusted-main` when AIWorks trusts local main (AW-005)."
- One new sentence under "Evidence and secrets": "AIWorks's own findings, owner decisions and review reports live in the local work list once it is on; GitHub issues are then a historical record."

### 8.4 docs/SUPERVISOR.md

- **§1 Boundary**, AW-005 bullet: "Runtime HEAD must be an ancestor of the trusted main: `origin/main`, or with `selfHosting.trustedMain: \"local\"` the trusted tip of local main (main ledger, section 6)."
- **§1**, the "Still GitHub only" bullet gains: "For AIWorks's own repository with local main trusted, `trackingIssue` and `issue` are work-list numbers and reports go to the work list."
- **§1**, last bullet: "Blockers and status are written to the store and posted on the campaign's tracking issue, or on its tracking item in the local work list."
- **§2 State and ownership**: "Campaign scope, assignment, findings, published status" is owned by "GitHub issues and PRs, or the local work list for AIWorks's own repository with local main trusted"; a new row "Trusted main of AIWorks's own repository | the main ledger in `supervisor.db`".
- **§3 Merge gate**: a "Local form" paragraph with the conditions and the merge of 4.4.
- **§6 Upgrade**, step 3: "Choose the commit. With `origin` trust, fetch, then take `git rev-parse origin/main`. With local trust, take `node src/supervisor/cli.mjs trusted-main --data <data>`. Never type a hash by hand."
- **§6 Governance checkout**: the local-trust behaviour of a failed pull (4.5).

## 9. Implementation slices

Each slice is one reviewable PR with `npm run check` and synthetic tests only. Paths use the plan's abbreviations (`sup/`, `dash/`, `pub/`, `ts/`, `td/`). Shared-file turns are in [plan §6.9](../PROJECT_WORKSPACE_PLAN.md#69-shared-files-and-the-order-that-avoids-conflicts).

| ID | Outcome | Owns | Depends on | Tests | Build slice |
| --- | --- | --- | --- | --- | --- |
| **L1** | A static test lists every GitHub call site of section 3.1; a new one fails with its `file:line`. Each later slice updates the list it shrinks. | `ts/github-boundary.test.mjs` (new) | none | The scanner first catches planted `gh api`, `exec(gh`, `fetch origin`, `push origin` and `ls-remote origin` calls; then the tree matches the list | SELF1 |
| **L2** | `selfHosting` validates; the main ledger and the trusted tip exist. Off by default. | `sup/self-hosting.mjs` (new), `sup/store.mjs` (`main_ledger`, additive), `ts/self-hosting.test.mjs` (new) | L1 | Malformed is off and logged; anchor accepted only equal to `origin/main` and local `main`; trusted tip, unrecorded commits and `MAIN_REWRITTEN` in disposable repositories | SELF2 |
| **L3** | Runtime provenance against the trusted tip; CLI `trusted-main`. Off: byte-identical messages. | `sup/provenance.mjs`, `sup/cli.mjs`, `sup/controller.mjs` (the texts at `src/supervisor/controller.mjs:69`, `:701`, `:715`, `:2559`), `sup/coordinator.mjs` (the text at `src/supervisor/coordinator.mjs:24`), `ts/provenance-local.test.mjs` (new) | L2 | No `origin` remote at all and the check passes; forged `update-ref` from a worker worktree not trusted; rewound main refused; no fetch | SELF3 |
| **L4** | Bases, worktrees, dependency integration and project check of the self-hosted repository read local refs and the ledger; no `gh`, no fetch; `ciRepair` refused for it. | `sup/controller.mjs` (`fetchBase`, `missingIntegratedDependencies`, base checks, `remoteBranches` use), `sup/adapters/git.mjs`, `sup/intake.mjs` (base pin), `sup/project-connect.mjs` (check without `gh`), `ts/local-base.test.mjs` (new) | L3 | Full implement, verify and integration-repair cycle in a repository with no remote; a fake `gh` that fails the test if run | SELF4 |
| **L5** | The work list exists: items, comments, numbering, bounds, secret check; CLI `work-list` read-only. | `sup/work-list.mjs` (new), `sup/store.mjs` (`work_items`, `work_item_comments`), `sup/cli.mjs`, `ts/work-list.test.mjs` (new) | L2 (store), L3 (cli) | Append-only comments; idempotency key; restart; secret-like body refused | SELF5 |
| **L6** | Workers, research snapshots, the coordinator and intake read the work list through the scoped reader for the self-hosted repository. | `sup/work-list-reader.mjs` (new), `sup/adapters/executors.mjs`, `sup/adapters/claude.mjs`, `sup/adapters/research-context.mjs`, `sup/coordinator.mjs`, `sup/intake.mjs` (issue route, links), `ts/work-list-reader.test.mjs` (new) | L5, L4 (intake) | Scope; identity first; no write; packet digests unchanged; other repositories' prompts byte-identical; no GitHub reader attached | SELF6 |
| **L7** | Publication, reports, repair notes, outbox and blockers of the self-hosted repository go to the work list; `aiworks-work:<n>` accepted, off until STA17. | `sup/controller.mjs` (`publish`, `enqueue`, `drainOutbox`), `sup/campaign.mjs`, `sup/owner-intervention.mjs` (link), `ts/local-review.test.mjs` (new) | L6, L4 | No push and no `gh`; crash after recording leaves one item; a report over 65,536 characters stored whole; GitHub targets byte-identical | SELF7 |
| **L8** | The local merge gate of 4.4, built off. | `sup/merge.mjs`, `sup/release/local-merge.mjs` (new), `ts/local-merge.test.mjs` (new), SUPERVISOR.md (merge gate, local form, "built, not enabled") | L7, L3 | Section 6 rows for SELF8; `ts/release-boundary.test.mjs` passes unchanged | SELF8 |
| **L9** | Optional backup push and the `selfHosting` status field (trusted tip, unrecorded commits, backup). | `sup/github-backup.mjs` (new), `sup/merge.mjs` (call after a recorded merge), `sup/api.mjs` (`selfHosting`), `ts/github-backup.test.mjs` (new), `ts/status.test.mjs` | L8 | Bare-repository remote; no force argument ever; refused and unreachable remotes reported, the next merge still happens; once per 10 minutes | SELF9 |
| **L10** | One-time import, read-only towards GitHub. | `sup/work-list-import.mjs` (new), `sup/cli.mjs` (`work-list import`), `ts/work-list-import.test.mjs` (new) | L5 | Fake `gh` sees only `GET`; pagination; pull requests skipped; numbers kept; re-run idempotent | SELF10 |
| **L11** | Close imported issues after the owner confirms. | `sup/work-list-import.mjs`, `sup/adapters/github.mjs` (`closeIssue`), `ts/work-list-import.test.mjs` | L10; WORK_ENVELOPE E11 (caller check) | Only the confirmed list; changed issue skipped; no second comment after a crash; synthetic AIWorks caller refused | SELF11 |
| **L12** | Dashboard: Resume uses the trust setting; local merge check without fetch; Settings shows trusted main and backup; work-list links. | `dash/supervisor.mjs`, `dash/merges.mjs`, `dash/owner.mjs`, `dash/copy.mjs`, `pub/dashboard.js`, `td/self-hosting.test.mjs` (new) | L3, L9 | No `git fetch` for the self-hosted repository; Resume refused on an unrecorded runtime; keyboard and 320px | UI19 |
| **L13** | Dashboard: the work list screen, owner decisions in Needs me, review items in Results, import and confirmed close. | `dash/work-list.mjs` (new), `dash/server.mjs` (routes with origin, CSRF, 16 KiB, caller check), `dash/owner.mjs`, `pub/*`, `docs/OPERATIONS_DASHBOARD.md`, `td/work-list.test.mjs` (new) | L12, L5, L10, L11 | Workers cannot write; close only after the typed confirmation; plain copy | UI20 |
| **L14** | The amended AW-001, AW-005, AGENTS.md and runbook text of section 8 land; `deploy.ps1 -Main local`. | `docs/DECISIONS.md`, `docs/PRODUCT_CONSTITUTION.md` (boundary bullet), `AGENTS.md`, SUPERVISOR.md, `scripts/supervisor/deploy.ps1`, `docs/STATUS.md` | L3 to L13 | `npm run check`; the text matches the owner's words of 2026-10-16 | SELF12 |
| **L15** | AIWorks runs from local main: disposable rehearsal, then the switch on the owner's computer through the upgrade procedure. Runbook only. | SUPERVISOR.md (switch on, switch back), `docs/STATUS.md` | L14 merged and deployed | Full suite at the deployed SHA; a whole task cycle with `gh` removed from `PATH`; status before and after | SELF13 |
