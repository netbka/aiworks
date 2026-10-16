# Design: connect GitHub, local Git and plain-folder projects

**Privacy boundary:** this is a design proposal, not a live installation record. Campaign declarations and approval records stay private under [AW-009](../DECISIONS.md#aw-009---public-commits-contain-no-installation-data). Any proposal to publish declarations through source branches or pull requests is superseded. Merged executable code, explicit owner authorization, scope binding and independent verification remain required.

**Status:** design only, for AIWorks design work. Nothing here is built, enabled or deployed. It implements section 3.1 of [PROJECT_WORKSPACE_PLAN.md](../PROJECT_WORKSPACE_PLAN.md) under the owner's decision D1 (section 8 there). Section 7 designs decision D2 as the owner decided it on 2026-10-16 (#24): it is planned, not built.

**Basis:** design notes; implementation status must be checked against the selected runtime revision.

Refs #7, Refs #14.

## 1. What the owner gets

- **Add a project from a folder.** In the local dashboard, type or paste a folder path. AIWorks looks at it and says what it found: a GitHub project, a local Git project or a plain folder. No JSON editing. A GitHub login is needed only for a GitHub project.
- **Your folder stays untouched.** Connecting only reads. AIWorks never writes a file in your folder, never runs `git init`, and never changes your Git branches, remotes or settings. For a folder without GitHub, AIWorks works on its own copy, kept outside your folder.
- **One honest status per project:** *Not connected*, *Needs setup*, *Ready* or *Temporarily unavailable*. Each status shows one sentence saying what happened and what to do.
- **Connecting does not start work.** Starting work stays a separate, approved step (#8). For a project without GitHub you also confirm its rules once in the dashboard (section 7), and you approve its plan in the dashboard ([WORK_ENVELOPE.md §8](WORK_ENVELOPE.md#8-decision-d4-local-admission-without-github)). The owner decided both on 2026-10-16. Neither is built yet (planned): today those projects can be connected, opened and planned, and the dashboard says why work cannot start.

## 2. Where things stand today (observed)

The design was first written before slices S1 to S6 were built. Every row below was re-checked against the code in this tree on 2026-10-16; a row marked *(since built)* describes code that was added after the design.

| Area | Current behaviour | Evidence |
| --- | --- | --- |
| Project identity | A campaign names `target.repository` as GitHub `owner/name`. *(since built)* A project record exists in the store, but a campaign binds to a project only through that GitHub name. | `src/supervisor/campaign.mjs:27`, `:123`; `src/supervisor/store.mjs:133-142`; `src/supervisor/project-connect.mjs:98-110` |
| Campaign authority | `authorization.reference` must be a GitHub URL. | `src/supervisor/campaign.mjs:114` |
| Local checkout | `config.json` `repositories["owner/name"]` gives `path` and `worktreeRoot`; *(since built)* a connected GitHub project gives them instead, and a disagreement between the two is `CONFIG_CONFLICT`. Dispatch fails without them. | `src/supervisor/controller.mjs:1604-1609`; `src/supervisor/project-connect.mjs:98-110`; `docs/SUPERVISOR.md:336` |
| Config readers | The dashboard and coordinator accept only `owner/name` keys. | `src/dashboard/projects.mjs:35-40`; `src/dashboard/merges.mjs:34-40`; `src/supervisor/coordinator.mjs:133-134` |
| Registration gate | A **new** campaign needs a registry entry whose `repository.github` matches `target.repository`, ignoring case. Resume and amendment are not gated. | `src/supervisor/campaign.mjs:444-451`, `:468-473`; `src/supervisor/cli.mjs:119-127` |
| Governance for packets | `projectGovernance` needs exactly one matching entry, refuses several, validates it against the governance contract's `schemas/project-contract.schema.json`, and derives policies from `policies/catalog.json`. Anything else throws and the worker is not dispatched. | `src/supervisor/campaign.mjs:489-496`, `:507-542`, `:16-24`; `src/supervisor/controller.mjs:1929-1938` |
| Governance checkout | `governanceRoot` must be absolute and hold `registry/projects`. There is no fallback. | `src/supervisor/governance.mjs:1-4`, `:29-40` |
| governance contract | `repository.github` is required, so the contract cannot describe a project without GitHub. `governance.observedAt` must be `<owner>/<repo>@<sha>`. | `tests/fixtures/governance/schemas/project-contract.schema.json:6`, `:10-17`, `:68-71`. Live governance main has the same schema; only one `$comment` differs. |
| Workspaces | Implementer worktrees are created in the owner's checkout (`git worktree add`, new branch), after `git fetch origin` unless a base SHA is given. Verified commits are pushed to `origin`. | `src/supervisor/adapters/git.mjs:25-39`, `:33`, `:35`, `:89-94`; `src/supervisor/controller.mjs:2019-2020`, `:2039-2040`, `:2261`, `:2281` |
| Store | SQLite is the only place state changes, with compare-and-swap on `version`. New tables are added with `CREATE TABLE IF NOT EXISTS`, and the store version stays the same. | `src/supervisor/store.mjs:1-4`, `:10`, `:19-150`, `:256-264`, `:179-181`, `:279-283` |
| Dashboard | Listens on `127.0.0.1` only. Commands need the same origin, a CSRF token and JSON of 16 KiB or less. | `src/dashboard/main.mjs:34`; `src/dashboard/server.mjs:39`, `:54-55`, `:85-95` |
| Secret-like paths | One pattern, shared with the governance contract's `projectPath`, rejects `.env*`, `.git`, `.ssh`, keys, certificates and credential or secret files. | `scripts/lib/worker-context.mjs:30-40`, `:52` |

**What this means:** for starting work, a project still *is* a GitHub repository. A project without GitHub can now be connected and planned, but it cannot be expressed in a campaign or in governance.

## 3. The project record

### 3.1 Fields

A project is a row in the supervisor store. It holds no credentials and no secret values.

| Field | Meaning and rule |
| --- | --- |
| `id` | Stable, owner-scoped project id. Set once at connect, from a short name the owner can edit before saving: lowercase, `^[a-z0-9][a-z0-9-]{1,39}$`, unique in this store. **It never changes**: not when the folder moves, the remote changes or the display name changes. After disconnect the id is kept as a tombstone and is never reused, so old work history cannot attach to a new folder. |
| `tenant_id` | The owner scope, for example `example-org`, as in campaign `target.tenantId` (`src/supervisor/campaign.mjs:122`). Together with `id` it is the project's identity. |
| `name` | Display name, at most 80 characters. The owner can change it. |
| `source_kind` | `github`, `local-git` or `folder`. It changes only through an explicit owner action, *Change connection type*, never as a side effect of a check. |
| `root_path` | Canonical root: `realpathSync.native` of the chosen folder. It is shown only in the owner's local dashboard. |
| `root_key` | The comparison key: `root_path` with `\` changed to `/` and, on Windows, lowercased. All overlap and duplicate checks use it. |
| `root_file_id` | `sha256(dev:ino)` from a bigint `stat` of the root, as the store already does for its own file (`src/supervisor/store.mjs:182-187`). It shows when a folder at the same path was replaced. |
| `fingerprint` | What makes this the *same* project. `github`: `owner/name`. `local-git`: the sorted root commit SHAs of the chosen branch (`git rev-list --max-parents=0`). `folder`: null, because a folder has nothing AIWorks may mark; moves are confirmed by the owner (section 4.6). |
| `github_repository`, `base_branch` | Only for `github`. `owner/name` with no URL, user info or token. |
| `local_branch` | Only for `local-git`: the branch AIWorks reads. |
| `mirror_root` | Only for `local-git` and `folder`: AIWorks's managed copy (section 5). It is never inside the source root, and the source root is never inside it. |
| `worktree_root` | Where task worktrees go. For `github` it comes from today's config (section 6). |
| `exclusions` | Only for `folder`: extra relative paths the owner chose to leave out (section 4.4). |
| `governance` | The governance binding: `{ kind: "registry", entryId, entryDigest, governanceRevision }`, `{ kind: "overlay", overlayId, entryDigest, governanceRevision }` (section 7), or `{ kind: "none" }`. `governanceRevision` is the governance checkout's `HEAD` at the last check. |
| `status`, `reason` | One of the four statuses (section 3.3) and a reason code from section 4. |
| `capabilities` | Checked flags: `plan` (read-only planning), `startWork` (dispatch allowed), `publish` (GitHub PR) or `apply` (local result, #13). Each has a reason when false. |
| `current_baseline` | Only for `local-git` and `folder`: the baseline that new work starts from (section 5.3). |
| `last_preflight` | Codes, counts and at most 10 example relative paths. Never file contents. |
| `version`, `created_at`, `updated_at`, `disconnected_at` | Compare-and-swap and tombstone fields, as for campaigns. |

### 3.2 Where it is stored

**Decision:** additive SQLite tables in the existing `supervisor.db`, not a new file and not `config.json`.

- The store is already the single mutation boundary with compare-and-swap (`src/supervisor/store.mjs:1-4`, `:256-264`). The owner and the dashboard can act on a project at the same time, and a JSON file would need its own locking.
- Adding tables keeps the store version, exactly as the owner-intervention tables do (`src/supervisor/store.mjs:279-283`). Older code ignores the new tables.
- `config.json` is the owner's hand-edited host configuration, read when `serve` starts (`src/supervisor/cli.mjs:180-181`). It stays the place for executable paths and the governance root. AIWorks never writes it.

Planned tables:

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, source_kind TEXT NOT NULL,
  root_path TEXT NOT NULL, root_key TEXT NOT NULL, root_file_id TEXT, fingerprint TEXT,
  github_repository TEXT, base_branch TEXT, local_branch TEXT, mirror_root TEXT, worktree_root TEXT,
  exclusions TEXT NOT NULL DEFAULT '[]', governance TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
  capabilities TEXT NOT NULL, current_baseline TEXT, last_preflight TEXT,
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, disconnected_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS projects_live_root ON projects (root_key) WHERE disconnected_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projects_live_github ON projects (lower(github_repository))
  WHERE disconnected_at IS NULL AND github_repository IS NOT NULL;
CREATE TABLE IF NOT EXISTS project_baselines (
  project_id TEXT NOT NULL, seq INTEGER NOT NULL, commit_sha TEXT NOT NULL, manifest_digest TEXT NOT NULL,
  files INTEGER NOT NULL, bytes INTEGER NOT NULL, excluded TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, seq));
CREATE TABLE IF NOT EXISTS project_overlays (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, entry TEXT NOT NULL, digest TEXT NOT NULL,
  approved_at INTEGER NOT NULL, revoked_at INTEGER);
```

Project events go to the existing `journal` table with `campaign_id` null and kind `project-*` (`src/supervisor/store.mjs:108-109`). The kinds are connected, preflight changed, baseline taken, relocated, disconnected, overlay approved and overlay revoked.

### 3.3 Status

The status always answers "can AIWorks use this project right now?". Whether work can *start* is the separate `startWork` capability, so a healthy local project is not shown as broken.

| Status | Meaning | Who acts |
| --- | --- | --- |
| **Not connected** | No live record: never added, or disconnected. | The owner adds it. |
| **Needs setup** | Something only the owner can fix: missing access, an ambiguous path, a changed identity, rules not available. Work for this project pauses. | The owner, following the one-line copy. |
| **Ready** | The last check passed. Planning is possible. `startWork` says whether work can start. | Nobody. |
| **Temporarily unavailable** | Something expected to come back: an unplugged drive, GitHub unreachable, files changing during a copy. AIWorks checks again when the project is opened and before any dispatch. | Nobody, unless it lasts. |

When status is checked:

- A **light check** runs when a project is opened and is cached for 60 seconds. It confirms the root exists, `root_file_id` and `fingerprint` are unchanged, the governance binding still resolves, and the mirror's head matches the recorded baseline.
- A **full check** runs at connect, on *Check again*, and before a new baseline is taken.
- No check calls a model. Only a GitHub project's full check calls GitHub, using read-only `gh` commands.

## 4. Detection and preflight

Preflight is read-only. It runs in the supervisor's Node process when the local dashboard asks for it, never in a worker.

### 4.1 Choosing the folder

- The owner types or pastes an absolute path. The dashboard offers no browser folder picker: ordinary browser code cannot see real local paths, and the File System Access API returns handles, not paths. All checks run on the server.
- The path is refused when it is relative, empty, longer than 1024 characters or contains control characters. UNC (`\\server\share`) and device paths (`\\?\`, `\\.\`) are refused too. Whether `realpathSync.native` turns a mapped network drive letter into a UNC path is **unknown**. The full check refuses any canonical root that starts with `\\`, and slice S2 tests this on workstation.
- **Canonical root:** `realpathSync.native(input)`. When it differs from the input (a symlink, junction or `subst` drive), the owner sees both paths and confirms the real one. Only the real path is stored.
- **Protected roots are refused:** a drive root; `%SystemRoot%`; `%ProgramFiles%` and `%ProgramFiles(x86)%`; the user profile root itself; and the AIWorks checkout, its `.local` directory, the data directory, the governance root, every configured `worktreeRoot` and every `mirror_root`, including anything inside them.
- **Overlap:** a root equal to, inside, or containing a live project's `root_key` is refused. An equal key means the folder is already connected (section 4.6).

### 4.2 Telling the kinds apart

Git is always run with `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks`, so `git status` cannot rewrite the index. AIWorks also passes `-c core.fsmonitor=false`, so a repository's own configuration cannot start an fsmonitor command. This is a per-command setting and writes no configuration. It never writes Git configuration and never adds `safe.directory`. (Workers already get a per-command `safe.directory` only for their own worktree: `src/supervisor/adapters/executors.mjs:291-295`.)

1. `git -C <root> rev-parse --show-toplevel --git-dir --git-common-dir --is-bare-repository`.
   - Not a repository → **plain folder**.
   - Bare → refused (`GIT_BARE`).
   - `--show-toplevel` ≠ root → refused (`GIT_SUBFOLDER`): connect the top level instead.
   - `--git-dir` ≠ `--git-common-dir` → a linked worktree, refused (`GIT_WORKTREE`).
   - "dubious ownership" → *Needs setup* (`GIT_UNTRUSTED`).
2. `git remote -v` (read-only). If `origin` is a `github.com` URL (https or ssh), parse `owner/name` and drop any user info. Any other remote host is ignored and never pushed to.
3. Proposed kind:
   - `origin` on GitHub → **GitHub**;
   - no `origin`, or a non-GitHub one → **Local Git**;
   - a Git repository with no commits → **Local Git**, which then fails with `GIT_NO_COMMITS`. The owner may switch to **Plain folder**; the `.git` directory is then left out like any secret-like path.
4. The owner may switch an unregistered GitHub checkout to **Local Git**. AIWorks then ignores the remote and never pushes. A checkout whose `owner/name` *is* in the governance registry must connect as **GitHub**, so that one repository never has two governance bindings.

### 4.3 Links, nested repositories and Windows case

These rules are for `folder` scans and for the `local-git` uncommitted-change notice. For Git kinds, only committed content reaches a worktree, so links and nested repositories follow Git's own behaviour, as they do today.

- **Links are never followed.** The scan uses `lstat`. Symbolic links and junctions (Node reports a junction as a symbolic link on Windows; slice S2 tests this) are left out and listed, whether their target is inside the root or outside it. A mirror that contains no links cannot be used to reach anything outside the folder.
- **Hard links** (`nlink > 1`) are copied by content and counted in the notice. Copying breaks the link inside the mirror only. Apply (#13) must treat them as a conflict class.
- **Nested repositories:** a directory that contains `.git` (a directory or a file) below the root is left out as a whole and listed, with the copy "connect it separately".
- **Case:** on Windows, `root_key` is lowercased. Inside a `folder` scan, two entries whose names are equal when case-folded are refused (`CASE_COLLISION`). The mirror is a Git repository with `core.ignorecase=true` on Windows and could not keep both. This can happen in a directory where per-directory case sensitivity is enabled.
- **Long paths:** the mirror repository sets `core.longpaths=true` in its *own* configuration. Paths over 4096 characters are refused.

### 4.4 What is left out of a plain folder

The following are never copied into the mirror, never shown by content and never given to a worker:

1. every path matching `SECRET_LIKE_PATH_PATTERN` (`scripts/lib/worker-context.mjs:36-40`), which includes `.env*`, `.git`, `.ssh`, keys, certificates and credential or secret files;
2. links and nested repositories (section 4.3);
3. paths matched by `.gitignore` files inside the folder. The `.gitignore` files are copied into the snapshot first. Then `git check-ignore --no-index --stdin` runs in the snapshot, with relative paths on standard input. Git never gets the source as a work tree;
4. `node_modules` directories by default, which the owner can override;
5. the owner's own `exclusions`.

The notice lists counts and at most 10 example relative paths for each class. A Git project is not filtered, because its worktrees contain only committed files, as today. A committed file that matches the secret-like pattern raises the notice `SECRET_TRACKED` and does not block.

### 4.5 Size, permissions and change during the scan

These limits apply to a `folder` scan. Each one stops before copying.

| Limit | Value | Code |
| --- | --- | --- |
| Included files | 200,000 | `TOO_LARGE` |
| Included bytes | 2 GiB | `TOO_LARGE` |
| Any single file | 100 MiB | `FILE_TOO_LARGE` |
| Scan time | 120 s | `SCAN_TIMEOUT` |
| Free disk space at the mirror | the included bytes × 2.2 (copy plus Git objects), from `fs.statfs` | `MIRROR_SPACE` |

- A file that is included but cannot be read stops the scan (`UNREADABLE_FILES`), because the baseline would be incomplete.
- **Change during the copy:** the scan records size, `mtimeNs` and SHA-256 for each file, copies, then hashes the copies again. A mismatch triggers one retry. A second mismatch gives `CHANGED_DURING_COPY` (*Temporarily unavailable*). The project's earlier baseline stays current.
- Binary files are allowed. The manifest marks them (a NUL byte in the first 8 KiB) so later review and apply can treat them differently.

### 4.6 Reconnect, relocation and identity changes

- **Same root key, same fingerprint:** the existing project opens. Nothing is created, so reconnecting is idempotent.
- **Same root key, different fingerprint or `root_file_id`:** *Needs setup* (`IDENTITY_CHANGED` or `ROOT_REPLACED`). Work pauses. AIWorks never switches identity on its own. The owner chooses either *This is still "{name}"* (for a folder, after AIWorks shows how many files match the last baseline by hash) or *Connect as a new project*.
- **Different root, same fingerprint** (a moved Git repository): AIWorks offers *Move "{name}" here*. Moving keeps `id` and history and writes a `project-relocated` journal entry.
- **A moved plain folder** has no fingerprint, so the owner chooses *Move "{name}" here* explicitly, with the match count shown.
- **Disconnect** writes `disconnected_at`. It deletes no history, no mirror and no worktree. Cleanup stays a separate maintenance step, as for worktrees today (`src/supervisor/adapters/git.mjs:3`).

## 5. The managed mirror (local Git and plain folders)

### 5.1 Where it lives

`mirror_root = <dirname(dataDir)>/mirrors/<projectId>/`. On workstation that is `C:/example/aiworks/.local/mirrors/<id>` (planned), next to `worktrees/` ([SUPERVISOR.md §6](../SUPERVISOR.md#6-installation-and-maintenance)). Connect checks that it is outside the source root and that the source root is outside it. `mirrors/` is under the already-ignored `.local/`.

### 5.2 Shape

- **Local Git:** `git init --bare <mirror_root>/repo.git`, then, inside the mirror, `git fetch --no-tags <root> +refs/heads/<local_branch>:refs/heads/source/<local_branch>`. The fetch reads the owner's repository and writes only into the mirror. *Refresh* repeats the same fetch. The owner's `.git` gets no worktree records, branches or configuration. Uncommitted owner changes are not included, and the dashboard says so (`UNCOMMITTED_NOTICE`).
- **Plain folder:** `<mirror_root>/snapshot/` is a normal Git repository that AIWorks owns. Its work tree is AIWorks's *copy*, never the source. Import syncs included files from the source into `snapshot/` (it reads the source and writes only the copy), removes copies of files that are gone from the source, then runs `git add -A` and commits on branch `aiworks/baseline` with `-c user.name="AIWorks" -c user.email=aiworks@localhost`. The repository's own `info/attributes` is `* -text -eol -filter -ident`, so content is stored byte for byte. Its hooks path is empty.
- Workers never get `mirror_root`. Task worktrees are created from the mirror with the existing adapter, `prepareImplementWorkspace({ repoPath: <mirror repo>, baseSha: <baseline commit> })`. The explicit `baseSha` skips the `fetch origin` (`src/supervisor/adapters/git.mjs:33`), so no remote is needed. Verification uses `prepareVerifyWorkspace` unchanged. `pushVerified` (`:89-94`) is never called for local kinds. Their result is a local revision plus evidence, never a fake PR (#8).

### 5.3 The baseline it binds

A **baseline** is one row in `project_baselines`:

- the mirror commit SHA;
- `manifest_digest`, the SHA-256 of the canonical JSON of the sorted `[relativePath, size, sha256, binary]` list;
- file and byte counts;
- the excluded-path summary.

For `local-git` the manifest is the commit's tree, and `manifest_digest` is the commit SHA.

- Connect takes baseline 1. A new baseline is taken only when the owner chooses *Refresh from folder*, or when the work-envelope flow (#8) asks for one before planning. There is no background re-import.
- Work binds to a baseline commit as its base SHA. The task packet's `revision` already carries a full SHA, so the packet format does not change.
- **Apply** belongs to #13 and #8, not here. It must rescan the source and compare it with the bound baseline's manifest, and stop on any change to a path the result touches. The manifest is what makes that check possible.
- If the mirror's `aiworks/baseline` head is not the recorded commit, the result is *Needs setup* (`MIRROR_CHANGED`). The owner chooses *Rebuild copy*, which re-imports into a fresh mirror and takes a new baseline. Old task worktrees and evidence are kept.

## 6. How `config.json` and the registration gate change

### 6.1 `config.json` `repositories`

- It stays readable and keeps working for every existing GitHub campaign. AIWorks never writes it.
- **Resolution in `Controller.repo()`** (observed: built; `src/supervisor/controller.mjs:1600-1609`, `src/supervisor/project-connect.mjs:98-110`):
  1. Look for a live project with `github_repository` equal to the campaign's `target.repository`, ignoring case.
  2. If there is none, use `config.repositories[...]`, as today.
  3. If both exist and their canonical paths or worktree roots differ, raise a B2 `project-connection` blocker with the `CONFIG_CONFLICT` copy and dispatch nothing. AIWorks never picks one.
- **Import:** for every `config.repositories` entry with no project, the dashboard offers *Add as project*. That runs the normal GitHub connect flow on `path` and reuses its `worktreeRoot`. Nothing is imported without the owner's click, so a stale entry cannot silently become a project.
- The dashboard lists the `config.json` repositories (`src/dashboard/projects.mjs:35-40`) and, when Add project is on, the connected projects (`src/dashboard/server.mjs:73-78`). It fetches no GitHub metadata for either (observed: `src/dashboard/server.mjs:30-32`).

### 6.2 `assertRegisteredTarget` and `projectGovernance`

- **GitHub projects keep the current gate exactly.** That means the same registry match (`src/supervisor/campaign.mjs:444-450`, `:469-473`), the same refusal of none or several entries (`:493-494`), the same schema validation (`:509-513`) and the same policy derivation (`:521-530`). Connect calls the same code (`src/supervisor/project-connect.mjs:13`), so a project that shows *Ready* would also pass the registration gate. Connect then stores `entryId` and `entryDigest`. When the entry changes, the next light check reports `REGISTRY_CHANGED`, re-resolves, and keeps *Ready* if it is still valid.
- **Refactor, same behaviour (observed: built).** The body of `projectGovernance` is now `governanceForContract(contract, root)` (`src/supervisor/campaign.mjs:489-496`, `:507-542`), so the registry path and the overlay path (section 7) can share one policy derivation:
  - `projectGovernance(repository, root)` = registry match + `governanceForContract`;
  - `overlayGovernance(entry, root)` (planned, slice S7) = overlay validation (section 7.4) + the same policy derivation, with `exceptions: []`.
- `assertRegisteredTarget` does not change in this design. A campaign for a local project needs a declaration without `target.repository` and an authorization that is not a GitHub URL. Both belong to local admission ([WORK_ENVELOPE.md §8](WORK_ENVELOPE.md#8-decision-d4-local-admission-without-github)). Until that is built and switched on (planned), starting work stays off for `local-git` and `folder` in code, not in a setting: `validateDeclaration` refuses every local target (`src/supervisor/campaign.mjs:355-358`), the project record refuses `startWork` for every kind but `github` (`src/supervisor/projects.mjs:68-71`), and a connected local project records `startWork` as not allowed (`src/supervisor/project-connect.mjs:257-262`). Turning it on is one reviewed code change (WORK_ENVELOPE slice E12) after D2 and D4, both decided by the owner on 2026-10-16. No `config.json` key enables it.

## 7. Decision D2: the rules a project without GitHub follows

**Decided by the owner on 2026-10-16 (#24, option 1, with one change: the overlay schema ships with AIWorks).** The owner said: "This AIworks should work with no dependency on Github." Nothing in this section is built yet (planned).

### 7.1 The problem

Registry membership *is* governance inheritance (governance GOVERNANCE_INHERITANCE.md §1). A registry entry needs `repository.github` (section 2). So a folder without GitHub cannot inherit governance through the registry, and a governance pull request per folder defeats D1. Skipping the check is not allowed.

### 7.2 The decision in one paragraph

**You confirm a project's rules once, in the dashboard.** AIWorks keeps a *local overlay*: one entry per project without GitHub, stored in AIWorks's own data directory. Each entry must pass a schema that **ships with AIWorks** and **can only add or tighten rules**. It has no exceptions, no release authorization, no environment other than `local`, and its independent verification gate is enabled. Every entry still inherits **every portfolio policy** from the governance directory, exactly as a registry entry does: AIWorks reads the policies there, read-only, and never writes there. The governance contract and its checkout do not change. Your confirmation is valid for up to 12 months and is bound to that exact entry.

### 7.3 The overlay entry

**(a) The schema (planned, slice S7).** It is a new AIWorks file, `schemas/local-project-overlay.schema.json`, reviewed and merged like any AIWorks code. It is not a governance file, and nothing is proposed to the governance contract.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://aiworks.local/schemas/local-project-overlay.schema.json",
  "title": "AIWorks local project overlay entry",
  "type": "object",
  "required": ["id", "name", "source", "lifecycle", "capabilities", "environments", "governance", "approval", "reviewBy"],
  "properties": {
    "id": { "type": "string", "pattern": "^lp-[a-z0-9][a-z0-9-]{0,38}$" },
    "name": { "type": "string", "minLength": 1, "maxLength": 80 },
    "source": {
      "type": "object", "required": ["kind"],
      "properties": { "kind": { "enum": ["local-git", "folder"] } },
      "additionalProperties": false
    },
    "lifecycle": { "enum": ["active", "experimental", "parked"] },
    "capabilities": { "type": "array", "uniqueItems": true, "maxItems": 16, "items": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,39}$" } },
    "environments": { "const": ["local"] },
    "governance": {
      "type": "object",
      "required": ["observedAt", "independentVerificationGate"],
      "properties": {
        "observedAt": { "type": "string", "pattern": "^local:lp-[a-z0-9][a-z0-9-]{0,38}@(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$" },
        "authorities": { "type": "array", "maxItems": 16, "items": { "$ref": "#/$defs/authority" } },
        "stricter": { "type": "array", "maxItems": 32, "items": { "$ref": "#/$defs/rule" } },
        "gaps": { "type": "array", "maxItems": 32, "items": { "$ref": "#/$defs/rule" } },
        "independentVerificationGate": { "const": "enabled" }
      },
      "additionalProperties": false
    },
    "approval": {
      "type": "object", "required": ["by", "at", "method", "digest"],
      "properties": {
        "by": { "type": "string", "minLength": 1, "maxLength": 80 },
        "at": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        "method": { "const": "owner-local-ui" },
        "digest": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      },
      "additionalProperties": false
    },
    "reviewBy": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
  },
  "$defs": {
    "authority": {
      "type": "object", "required": ["role", "path"],
      "properties": {
        "role": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,39}$" },
        "path": { "type": "string", "minLength": 1, "maxLength": 200 }
      },
      "additionalProperties": false
    },
    "rule": {
      "type": "object", "required": ["id", "rule"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" },
        "rule": { "type": "string", "minLength": 1, "maxLength": 200 },
        "note": { "type": "string", "maxLength": 500 }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

What the schema leaves out, on purpose: `repository`, `resources`, `secrets`, `governance.exceptions` and `governance.releaseAuthorization`. A gap carries an optional local `note` instead of a GitHub link, so recording one needs no GitHub step. A gap waives nothing: the policy it names still applies.

**(b) The rules the schema cannot express.** AIWorks enforces them in code (slice S7) and tests each one.

1. **Membership is inheritance.** An admitted overlay entry is governed exactly like a registry entry (governance GOVERNANCE_INHERITANCE.md §1): the Constitution with its baseline, the portfolio decisions and every portfolio policy that applies. The entry lists no policies, so none can be left out. The policies come from the governance directory's `policies/catalog.json`, derived by the same code as for a registry entry (`src/supervisor/campaign.mjs:521-530`).
2. **The governance directory is still required.** Overlay governance needs the same configured governance root as a registry entry (`src/supervisor/governance.mjs:29-38`). If it is missing or unreadable, every overlay entry is inert and the result is `RULES_UNAVAILABLE`. There is no fallback rule set.
3. **Capabilities use governance's own words.** Each capability must appear in the capability list of the governance root's `schemas/project-contract.schema.json`, read at the same time. An unknown capability is refused, so an entry cannot invent one to avoid a policy.
4. **Disjoint identity.** `id` starts with `lp-`. It must not equal any registry id in the governance root, and it is unique among AIWorks's overlay entries and never reused. On governance main (observed with `gh api` when this design was first written) no registry id starts with `lp-`. (`local-tool` exists, which is why the prefix is not `local-`.)
5. **Add or tighten only.** There are no exceptions and no release authorization. `environments` is `["local"]`. `independentVerificationGate` is `enabled`. Authority paths are repository-relative and never secret-like (the shared pattern, `scripts/lib/worker-context.mjs:36-40`). A project that needs more is registered in governance as a GitHub project. That is a new identity.
6. **Owner confirmation, bound.** Only the owner creates or renews an entry, through the dashboard (section 7.4). `approval.digest` is the SHA-256 of the canonical JSON of the entry without `approval`, so any later edit invalidates the confirmation.
7. **Expiry.** `reviewBy` is at most 365 days after `approval.at`. After `reviewBy` the entry is not admissible until the owner renews it.
8. **Never in the governance checkout.** Overlay entries live in AIWorks's store. AIWorks reads governance read-only.
9. **Same packet values.** Workers receive the same values as for a registry entry: the id, the policy ids from the catalog, the authorities, and the ids and rules of any gaps. Exceptions are always empty.
10. **Visibility.** Governance's own conformance report cannot see local overlays. The dashboard shows every entry, its rules and its expiry to the owner.

### 7.4 What AIWorks enforces (planned, in slices S7 and S8)

- **Validation.** Each entry is validated at every admission and before every dispatch: first against AIWorks's own schema, compiled once like the contract schema (`src/supervisor/campaign.mjs:16-24`), then against rules 2 to 7.
- **One derivation of policies.** `governanceForContract` holds the schema check and the policy derivation together (`src/supervisor/campaign.mjs:507-542`). Slice S7 splits them without changing behaviour. `overlayGovernance(entry, root)` then runs the overlay checks and the same derivation, with `exceptions: []`. The project record already accepts an overlay binding (`src/supervisor/projects.mjs:75-79`).
- **Who may write.** Entries are written only by the dashboard's owner command path. The dashboard checks the exact origin and requires its CSRF token (`src/dashboard/server.mjs:54-55`, `:85-88`). The owner reviews the rules on one screen and types the project name to confirm. No supervisor, worker or coordinator code path writes `project_overlays`; a code search test asserts it. What stops another program on the same computer is the same as for plan approval ([WORK_ENVELOPE.md §8.2](WORK_ENVELOPE.md#82-threat-model)).
- **Revocation.** The owner can revoke an entry in the dashboard at any time. A revoked or expired entry raises the B2 `project-governance` blocker on dispatch, with the same behaviour as today's governance failure.

### 7.5 Threats D2 closes

| Threat | Closed by |
| --- | --- |
| A local project claims a registered project's rules, or hides under its name | Disjoint `lp-` ids checked against the registry; GitHub kind required for registered repositories (section 4.2); the refusal of several matches is kept (`src/supervisor/campaign.mjs:494`) |
| An overlay drops a portfolio policy | Overlay entries list no policies. Policies are derived from the governance catalog by the same code as registry entries. |
| An overlay invents a capability to avoid a policy | Capabilities must be in governance's own capability list (rule 3) |
| An overlay smuggles in an exception or release authority | The schema has no `exceptions` and no `releaseAuthorization`; `environments` is `local` only |
| Independent verification is turned off | `independentVerificationGate` is `const: "enabled"` |
| An agent registers its own project, or widens one | Only the owner command path writes overlays; the digest binds the confirmed content |
| A stale confirmation lives forever | `reviewBy` of at most 365 days; inadmissible after it |
| The governance directory is missing, so no policy would apply | Every overlay entry is inert (`RULES_UNAVAILABLE`); there is no fallback |
| The governance checkout is changed | Overlays live in the AIWorks store; the checkout stays read-only |
| A worker is pointed at a secret file | Authority paths use the shared secret-like exclusion |

D2 waives no governance policy, changes nothing in the governance contract, and writes nothing in the governance checkout. The trade-off the owner accepted: AIWorks, not governance, holds the overlay schema. So a change to it is an AIWorks code change, under independent review of its exact head (AGENTS.md).

## 8. Connect flows, failure copy and tests

The copy below is exact owner-facing English (D9). `{…}` are placeholders. Each message is one or two short sentences, and its primary action is in the last column.

### 8.1 Common to every kind

| Code | Status | Copy | Action |
| --- | --- | --- | --- |
| `PATH_NOT_ABSOLUTE` | not saved | Enter the full folder path, for example D:\Projects\my-app. | — |
| `PATH_NOT_FOUND` | not saved | AIWorks can't find this folder. Check the path and try again. | — |
| `PATH_NOT_DIRECTORY` | not saved | This is a file, not a folder. Choose the project's folder. | — |
| `PATH_NETWORK` | not saved | Network folders aren't supported. Copy the project to a drive on this computer and connect it there. | — |
| `PATH_PROTECTED` | not saved | AIWorks can't use this folder: it's a drive, a system folder or part of AIWorks itself. Choose a project folder. | — |
| `PATH_OVERLAP` | not saved | This folder overlaps the project "{name}". Projects can't be inside each other. | Open "{name}" |
| `PATH_UNREADABLE` | not saved | AIWorks can't read this folder. Check that your Windows account can open it. | Check again |
| `PATH_IS_LINK` | confirm | This path leads to {canonical}. AIWorks will use that folder. | Use this folder |
| `ALREADY_CONNECTED` | opens | This folder is already connected as "{name}". | Open "{name}" |
| `ROOT_MISSING` | Temporarily unavailable | AIWorks can't reach {path}. If it's on a removable drive, plug it in. | Check again |
| `ROOT_REPLACED` | Needs setup | The folder at {path} was replaced. Confirm it's still "{name}" before work continues. | Review |
| `IDENTITY_CHANGED` | Needs setup | {path} now holds a different project ({was} → {now}). AIWorks stopped work here. | Review |
| `GOVERNANCE_ROOT_MISSING` | Needs setup | AIWorks can't find the project rules on this computer, so it can't add a project yet. The fix is outside AIWorks: the AIWorks configuration file on this computer must name the folder that holds the project rules. Then choose Check again. | Check again |
| `GIT_CLI_MISSING` | Needs setup | AIWorks can't find Git on this computer, so it can't check this folder. The fix is outside AIWorks: install Git, or name where it is in the AIWorks configuration file on this computer. Then choose Check again. | Check again |

### 8.2 GitHub project

**Flow:**
1. Path checks (section 4.1).
2. Git detection gives `origin` = `owner/name`.
3. `gh auth status`, then `gh repo view owner/name --json nameWithOwner,defaultBranchRef,viewerPermission` (read-only).
4. Exactly one governance registry entry via the existing match (section 6.2).
5. Base branch: the default is GitHub's default branch, and the owner can change it. It is checked with `git ls-remote --heads origin <branch>`, which reads only.
6. `worktree_root` defaults to `<dirname(dataDir)>/worktrees/<name>`, the layout in [SUPERVISOR.md §6](../SUPERVISOR.md#6-installation-and-maintenance).
7. Check against `config.json` (section 6.1).
8. Save, giving *Ready*.

Nothing is fetched or created at connect: no `git fetch`, no worktree and no branch. These happen only at dispatch, as today.

| Code | Status | Copy | Action |
| --- | --- | --- | --- |
| `GH_MISSING` | Needs setup | GitHub projects need the GitHub CLI (gh). Install it, sign in with gh auth login, then check again. | Check again |
| `GH_SIGNED_OUT` | Needs setup | The GitHub CLI isn't signed in. Run gh auth login, then check again. | Check again |
| `GH_NO_ACCESS` | Needs setup | Your GitHub account can't open {repo}. Check the repository and your access. | Check again |
| `GH_UNREACHABLE` | Temporarily unavailable | GitHub can't be reached right now. Your project is unchanged; AIWorks will check again. | Check again |
| `BRANCH_MISSING` | Needs setup | {repo} has no branch named {branch}. Choose the branch AIWorks should start from. | Choose branch |
| `REGISTRY_MISSING` | Needs setup | {repo} isn't listed in your project rules, so AIWorks can plan but not start work. Add it there, then check again. | Check again |
| `REGISTRY_AMBIGUOUS` | Needs setup | Your project rules list {repo} more than once ({ids}). AIWorks won't guess which rules apply. | Check again |
| `REGISTRY_INVALID` | Needs setup | The entry for {repo} in your project rules has an error, so AIWorks can't read its rules. | Check again |
| `REGISTRY_CHANGED` | Ready, or the code above | (Notice) The project rules for {repo} changed. AIWorks uses the new rules. | — |
| `CONFIG_CONFLICT` | Needs setup | The AIWorks configuration file on this computer puts {repo} at {configPath}, but this project is at {root}. AIWorks won't guess which one is right. Correct that entry in the configuration file, which is outside AIWorks, or disconnect this project. Then choose Check again. | Check again |
| `GIT_SUBFOLDER` | not saved | This folder is inside the Git repository {top}. Connect {top} instead. | Use {top} |
| `GIT_WORKTREE` | not saved | This folder is a Git worktree. Connect the main checkout at {main} instead. | Use {main} |
| `GIT_BARE` | not saved | This is a bare Git repository with no files. Connect a normal checkout. | — |
| `GIT_UNTRUSTED` | Needs setup | Git doesn't trust this folder because another Windows account owns it. Fix the owner, or add it to Git's safe.directory yourself; AIWorks won't change Git settings. | Check again |
| `SECRET_TRACKED` | notice | {count} committed files look like secrets, for example {path}. Workers will see them. | — |

**Tests** (synthetic `gh` and `git` remotes from `tests/supervisor/helpers.mjs`; no network):
- a GitHub checkout connects, gives *Ready*, and stores `owner/name` without the URL's user info;
- before/after snapshot of the source, including every file under `.git`: byte-identical, with no new refs, worktrees or config keys;
- each `gh` failure maps to its code, using synthetic `gh` exit codes and messages;
- registry missing, duplicate and invalid entries use the fixture governance copies;
- `CONFIG_CONFLICT` raises the B2 blocker and does not dispatch;
- `Controller.repo()` prefers the project record and falls back to config;
- `GIT_SUBFOLDER`, `GIT_WORKTREE` and `GIT_BARE` use disposable repositories;
- a second connect of the same root is idempotent;
- a changed `origin` gives `IDENTITY_CHANGED`.

### 8.3 Local Git project

**Flow:**
1. Path checks.
2. Git detection, with no `origin` or a non-GitHub one.
3. Branch choice, defaulting to the current branch, which must have commits.
4. Fingerprint = root commits.
5. Governance binding: overlay, if D2 is in force (section 7), otherwise `none`.
6. Mirror clone (section 5.2) and baseline 1.
7. Save. The result is *Ready* with `plan: true` and `startWork: false`, or *Needs setup* when a code below applies.

| Code | Status | Copy | Action |
| --- | --- | --- | --- |
| `GIT_NO_COMMITS` | not saved | This Git repository has no commits yet. Make a first commit, or connect it as a plain folder. | Connect as plain folder |
| `UNCOMMITTED_NOTICE` | notice | You have changes that aren't committed. AIWorks works from your last commit ({sha7}) and never touches your files. | — |
| `MIRROR_SPACE` | not saved | There isn't enough free space for AIWorks's copy: {need} needed, {free} free on {drive}. | Check again |
| `MIRROR_CHANGED` | Needs setup | AIWorks's copy of this project changed unexpectedly, so AIWorks stopped using it. | Rebuild copy |
| `LOCAL_START_OFF` | Ready, `startWork: false` | You can open and plan work here. Starting work on projects without GitHub isn't available yet: it waits for two approvals (D2 and D4). | — |
| `RULES_UNAVAILABLE` | Needs setup | AIWorks can't read your project rules right now, so this project has no rules to work under. Check the rules folder in Settings. | Check again |
| `RULES_NEED_APPROVAL` | Needs setup | Confirm this project's rules to let AIWorks work here. You do this once; it lasts up to 12 months. | Review rules |
| `RULES_EXPIRED` | Needs setup | Your approval of this project's rules ended on {date}. Review it again to continue. | Review rules |
| `RULES_REVOKED` | Needs setup | You revoked this project's rules, so work can't start here. Confirm them again to continue. | Review rules |

`RULES_*` appear only after slice S7 (planned). Until then, local projects show `LOCAL_START_OFF`, with the copy above, which is today's shipped copy (observed, `src/supervisor/project-connect.mjs:49`). It still names D2 and D4 as waiting, although the owner decided both on 2026-10-16. Slice E12 of WORK_ENVELOPE replaces the copy in code and in this row together, because `tests/dashboard/connect.test.mjs` checks that they are equal.

The copy calls the governance platform "your project rules", the owner word of [OWNER_WORKSPACE §2.1](OWNER_WORKSPACE.md#21-words-the-owner-sees); its name stays in details and in this design (aiworks#11 review 4 F4). The dashboard says the `REGISTRY_*` rows and `GITHUB_REGISTERED` in these words (`src/dashboard/projects.mjs`).

**Tests** (disposable repositories, no remote):
- a no-remote repository connects. The mirror is created outside the source, and baseline 1's commit equals the branch head;
- byte-identical before/after snapshot of the source including `.git`, with no new worktree records (`.git/worktrees` absent or unchanged) and no new refs;
- *Refresh* takes baseline 2 after a new commit;
- uncommitted changes give `UNCOMMITTED_NOTICE` and are not in the mirror;
- an empty repository gives `GIT_NO_COMMITS`;
- a non-GitHub `origin` is treated as Local Git and is never contacted (synthetic remote URL; the test fails if any command touches it);
- a different root commit at the same path gives `IDENTITY_CHANGED`;
- a moved repository is offered *Move here* and keeps its id;
- tampering with the mirror head gives `MIRROR_CHANGED`;
- `startWork` is false, with `LOCAL_START_OFF`;
- a worktree from the mirror via `prepareImplementWorkspace` with `baseSha` makes no `fetch origin` call.

### 8.4 Plain folder

**Flow:**
1. Path checks.
2. Git detection finds no repository.
3. Scan (sections 4.3 to 4.5) with an exclusion preview: counts, examples, and owner edits to `exclusions`.
4. Copy into `snapshot/`, re-hash, commit, giving baseline 1.
5. Governance binding as for Local Git.
6. Save. The result is *Ready* with `plan: true` and `startWork: false`.

| Code | Status | Copy | Action |
| --- | --- | --- | --- |
| `EXCLUDED_NOTICE` | notice | AIWorks left out {n} items and never copies them: {secrets} secret-like files (for example .env), {links} links, {repos} other Git repositories, {ignored} ignored files. | Show list |
| `TOO_LARGE` | not saved | This folder is too big to copy safely ({files} files, {size}). Leave out large folders such as build output, or choose a smaller folder. | Edit exclusions |
| `FILE_TOO_LARGE` | not saved | {count} files are larger than 100 MB, for example {path}. Leave them out to continue. | Edit exclusions |
| `SCAN_TIMEOUT` | not saved | Reading this folder took too long. Leave out large folders, then try again. | Edit exclusions |
| `UNREADABLE_FILES` | not saved | AIWorks can't read {count} files, for example {path}. Fix their permissions or leave them out. | Edit exclusions |
| `CASE_COLLISION` | not saved | {a} and {b} differ only in capital letters. AIWorks's copy can't keep both. Rename one or leave it out. | Edit exclusions |
| `CHANGED_DURING_COPY` | Temporarily unavailable | Files changed while AIWorks was copying them. Finish saving your work, then check again. | Check again |
| `MIRROR_SPACE`, `MIRROR_CHANGED`, `LOCAL_START_OFF`, `RULES_*` | as in 8.3 | as in 8.3 | as in 8.3 |

**Tests** (real temporary folders):
- a folder with no `.git` and no remote connects. The mirror's tree equals the included files byte for byte, including CRLF, a binary file and a non-ASCII name;
- **the source is unchanged:** paths, sizes, `mtimeNs`, hashes and directory listing are identical before and after preflight, connect, refresh and rebuild, and no `.git` appears in the source;
- `.env`, `id_rsa`, `*.pem` and `.git` are excluded and never present in the mirror's objects (`git cat-file --batch-all-objects`);
- a junction to outside the root (`fs.symlinkSync(target, path, 'junction')`, no privilege needed) and one to inside it are both left out and listed;
- a nested `.git` directory is left out;
- `.gitignore` inside the folder is honoured, and Git is never given the source as a work tree (asserted from the recorded command lines of a synthetic `git` wrapper);
- `node_modules` is left out by default;
- the limits use test-sized values: files, bytes, single file, time and space (with `fs.statfs` injected);
- `CASE_COLLISION`, through an injected directory listing (NTFS cannot hold both names without per-directory case sensitivity) and on a real case-sensitive directory where the platform supports it;
- a file changed between hash and re-hash, through an injected hook, gives one retry and then `CHANGED_DURING_COPY`, with the previous baseline kept;
- moving the folder and choosing *Move here* keeps the id;
- a deleted file disappears from baseline 2;
- the mirror root is refused inside the source, and the source inside the mirror.

### 8.5 Two projects at once (acceptance from #7)

One test connects a GitHub project (synthetic) and a plain folder side by side. Their `id`, mirror, worktree root and governance binding are separate. Lists and statuses come back independently. A failure in one does not change the other's status. Connecting either starts no dispatch: no operations rows, and no worker spawn recorded by the synthetic executables.

### 8.6 Dashboard acceptance

The *Add project* screen and the project list follow the owner-workspace design (#11, `docs/design/OWNER_WORKSPACE.md`, which another task writes). This design supplies the API and the copy above. The acceptance comes from governance UX-001 and UX-002, which are linked and not restated here:
- keyboard-only connect;
- 320px width without horizontal scroll;
- a label for every field;
- the status announced to screen readers;
- one primary action per state.

## 9. Owner-reserved questions

D1, D3, D5 and D9 are settled and are not asked again. D4 (local admission) is designed in [WORK_ENVELOPE.md §8](WORK_ENVELOPE.md#8-decision-d4-local-admission-without-github).

**Answered on 2026-10-16 (#24).** Both questions this section used to ask are answered, and nothing here asks the owner any more:

1. **How does a project without GitHub get its rules (D2)?** Through a local overlay whose schema ships with AIWorks (section 7). Governance is not changed. Every entry inherits every portfolio policy from the governance directory and can only add or tighten rules.
2. **Is a typed confirmation in the local dashboard enough owner approval for one project's rules?** Yes (#24 option 1). It is the approval method `owner-local-ui`, valid for up to 12 months and bound to the exact entry by its digest.

The following are decided here and are not owner questions:
- the storage choice (section 3.2);
- the size limits (section 4.5);
- the mirror location (section 5.1);
- refusing network folders and nested projects;
- leaving out links;
- allowing an unregistered GitHub checkout to connect as Local Git.

## 10. Implementation slices

Each slice is one reviewable PR. Every change under `src/supervisor/` needs independent approval of the exact head commit (AGENTS.md). The #5 and #6 owners have priority on `api.mjs` and `campaign.mjs`. All tests are synthetic: temporary folders, disposable Git repositories and synthetic `git`/`gh` wrappers. They make no network, model or GitHub calls. Each slice ends with `npm run check`. Merged is not deployed: the live runtime changes only through the upgrade procedure.

| # | Outcome | Files it owns | Tests | Acceptance | Depends on | Waits for a decision |
| --- | --- | --- | --- | --- | --- | --- |
| **S1** | Project records exist and survive restarts | `src/supervisor/projects.mjs` (new); `src/supervisor/store.mjs` (additive DDL only) | `tests/supervisor/projects.test.mjs`: an old store gains the tables with the store version unchanged; compare-and-swap conflict; id rules; tombstone ids never reused; unique live root and GitHub repository; a remote URL with user info is stored as `owner/name` only; journal entries | Records can be created, read and disconnected through the module; no other behaviour changes | — | No |
| **S2** | Read-only preflight tells the three kinds apart | `src/supervisor/project-preflight.mjs` (new) | `tests/supervisor/project-preflight.test.mjs`: every path code in 8.1; Git detection codes; the junction is reported as a link; case collision; limits; the source snapshot is unchanged, including `.git`; Git commands carry `--no-optional-locks`; no write commands are issued | Every row of 8.1 and the detection rows of 8.2 to 8.4 return their code; the snapshot equality test passes | S1 | No |
| **S3** | GitHub projects connect, and campaigns resolve their checkout through them | `src/supervisor/project-connect.mjs` (new); `src/supervisor/controller.mjs` (`repo()` only); `src/supervisor/campaign.mjs` (extract `governanceForContract`, same behaviour) | `tests/supervisor/project-github.test.mjs`; the existing `campaign-registry` and `packet-governance` tests stay unchanged and pass | 8.2 complete; `CONFIG_CONFLICT` blocks dispatch; existing campaigns run unchanged | S1, S2; #5 and #6 for `campaign.mjs` | No |
| **S4** | Local Git projects connect with a managed mirror | `src/supervisor/adapters/mirror.mjs` (new, local-Git part); `src/supervisor/project-connect.mjs` | `tests/supervisor/project-local-git.test.mjs` (8.3 list) | 8.3 complete; `startWork` false with `LOCAL_START_OFF`; the owner's `.git` is untouched | S1, S2 | No (starting work waits for S7, S8 and WORK_ENVELOPE E12) |
| **S5** | Plain folders connect with a managed snapshot and baselines | `src/supervisor/adapters/mirror.mjs` (folder part) | `tests/supervisor/project-folder.test.mjs` (8.4 list) | 8.4 complete; the source is byte-identical after connect, refresh and rebuild; secret-like files are absent from the mirror's objects | S1, S2, S4 | No |
| **S6** | The owner adds and sees projects in the dashboard | `src/dashboard/projects.mjs` (new); `src/dashboard/server.mjs` (routes `GET /api/projects`, `POST /api/projects/preflight`, `/connect`, `/check`, `/relocate`, `/disconnect`, with the same origin, CSRF and 16 KiB rules); `src/dashboard/public/*` (the Projects area only); `docs/OPERATIONS_DASHBOARD.md` | `tests/dashboard/projects.test.mjs`: route security (origin, CSRF, size); exact copy for each code; no absolute path in any response except the owner's own project root; the two-project acceptance (8.5); keyboard and 320px checks per UX-001/UX-002 | 8.5 and 8.6 pass; the blind owner review from #11 has run | S3, S4, S5; the DS-WORKSPACE design (#11) | No |
| **S7** | The AIWorks side of D2: overlay entries are validated against the schema AIWorks ships, and get the same policies as a registry entry | `schemas/local-project-overlay.schema.json` (new); `src/supervisor/local-overlay.mjs` (new: rules 2 to 7 of 7.3(b), the `project_overlays` table already exists in the store, `src/supervisor/store.mjs:147-149`); `src/supervisor/campaign.mjs` (split `governanceForContract` into schema check and derivation, same behaviour; add `overlayGovernance`) | `tests/supervisor/local-overlay.test.mjs`: a missing governance root gives `RULES_UNAVAILABLE`; an unknown capability is refused; `lp-` prefix, registry-id collision and reuse refused; digest mismatch; expired `reviewBy` and a `reviewBy` more than 365 days out; `exceptions`, `releaseAuthorization`, `environments: ["prod"]`, gate `not-enabled`, a secret-like authority path and `repository` each refused; policies equal to the registry derivation for the same capabilities; the existing `campaign-registry` and `packet-governance` tests pass unchanged | Rules 1 to 10 of 7.3(b) hold; local admission stays off | S1, S4 | No (decided 2026-10-16, #24) |
| **S8** | The owner confirms, renews and revokes a local project's rules once, in the dashboard | `src/dashboard/projects.mjs`; `src/dashboard/server.mjs` (rules routes, same origin, CSRF and 16 KiB rules); `src/dashboard/public/*` (rules review screen) | Typed project name required; only the owner route writes `project_overlays`; renewal changes the digest and `reviewBy`; revoke makes the entry inadmissible at the next check; a confirmation more than 365 days old is refused; the screen lists every inherited policy id | `RULES_*` copy shown; no worker or coordinator path can write overlays (asserted by a code search test and by route tests); keyboard and 320px checks per UX-001/UX-002 | S6, S7 | No (decided 2026-10-16, #24) |

Starting work on local projects is not a slice of #7. It is built in [WORK_ENVELOPE.md §12](WORK_ENVELOPE.md#12-implementation-slices) (E11, E12), after S7 and S8. Applying a result to the owner's folder is the owner's Apply action (WORK_ENVELOPE §8.6, slice E13). It uses the baselines from S5 and is not Auto Release.
