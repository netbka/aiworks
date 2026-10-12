# Design: connect GitHub, local Git and plain-folder projects

**Status:** design only, for [netbka/aiworks#7](https://github.com/netbka/aiworks/issues/7). Nothing here is built, enabled or deployed. It implements section 3.1 of [PROJECT_WORKSPACE_PLAN.md](../PROJECT_WORKSPACE_PLAN.md) under the owner's decision D1 (section 8 there). It designs decision D2 and does not enable it.

**Basis:** `netbka/aiworks` at `acb9e66a35980a68bf0bfacfbb01f6bfaa902261`. Engineering Platform (EP) was read only, with `gh api`, at main `4c3eede9fb3ce470ba155da0150a6498ec824630`. Every statement about current behaviour cites `file:line` at that AIWorks revision and is **observed** (read in code or docs). Nothing in this document was checked on the live HomePc runtime, so nothing here is **verified**. Everything that is not current behaviour is **planned**.

Refs #7, Refs #14.

## 1. What the owner gets

- **Add a project from a folder.** In the local dashboard, type or paste a folder path. AIWorks looks at it and says what it found: a GitHub project, a local Git project or a plain folder. No JSON editing. A GitHub login is needed only for a GitHub project.
- **Your folder stays untouched.** Connecting only reads. AIWorks never writes a file in your folder, never runs `git init`, and never changes your Git branches, remotes or settings. For a folder without GitHub, AIWorks works on its own copy, kept outside your folder.
- **One honest status per project:** *Not connected*, *Needs setup*, *Ready* or *Temporarily unavailable*. Each status shows one sentence saying what happened and what to do.
- **Connecting does not start work.** Starting work stays a separate, approved step ([#8](https://github.com/netbka/aiworks/issues/8)). For projects without GitHub, starting work also waits for two decisions that are not taken yet: D2 (section 7 of this document) and D4 (AW-005 local admission, [#8](https://github.com/netbka/aiworks/issues/8)). Until then, those projects can be connected, opened and planned, and the dashboard says why work cannot start.

## 2. Where things stand today (observed)

| Area | Current behaviour | Evidence |
| --- | --- | --- |
| Project identity | There is no project object. A campaign names `target.repository` as GitHub `owner/name`. | `src/supervisor/campaign.mjs:25`, `:109` |
| Campaign authority | `authorization.reference` must be a GitHub URL. | `src/supervisor/campaign.mjs:100` |
| Local checkout | `config.json` `repositories["owner/name"]` gives `path` and `worktreeRoot`. Dispatch fails without them. | `src/supervisor/controller.mjs:542-546`; `docs/SUPERVISOR.md:218`, `:221` |
| Config readers | The dashboard and coordinator accept only `owner/name` keys. | `src/dashboard/roadmap.mjs:24-29`; `src/supervisor/coordinator.mjs:105-106` |
| Registration gate | A **new** campaign needs a registry entry whose `repository.github` matches `target.repository`, ignoring case. Resume and amendment are not gated. | `src/supervisor/campaign.mjs:230-236`, `:239-243`; `src/supervisor/cli.mjs:66-72` |
| Governance for packets | `projectGovernance` needs exactly one matching entry, refuses several, validates it against EP's `schemas/project-contract.schema.json`, and derives policies from `policies/catalog.json`. Anything else throws and the worker is not dispatched. | `src/supervisor/campaign.mjs:259-299`, `:15-22`; `src/supervisor/controller.mjs:603-608` |
| Governance checkout | `governanceRoot` must be absolute and hold `registry/projects`. There is no fallback. | `src/supervisor/governance.mjs:12-20`, `:27-38` |
| EP contract | `repository.github` is required, so the contract cannot describe a project without GitHub. `governance.observedAt` must be `<owner>/<repo>@<sha>`. | `tests/fixtures/governance/schemas/project-contract.schema.json:6`, `:10-17`, `:68-71`. Live EP main has the same schema; only one `$comment` differs. |
| Workspaces | Implementer worktrees are created in the owner's checkout (`git worktree add`, new branch), after `git fetch origin` unless a base SHA is given. Verified commits are pushed to `origin`. | `src/supervisor/adapters/git.mjs:25-39`, `:33`, `:35`, `:81-85`; `src/supervisor/controller.mjs:648`, `:660`, `:830` |
| Store | SQLite is the only place state changes, with compare-and-swap on `version`. New tables are added with `CREATE TABLE IF NOT EXISTS`, and the store version stays the same. | `src/supervisor/store.mjs:1-4`, `:10`, `:19-77`, `:157-165`, `:180-181` |
| Dashboard | Listens on `127.0.0.1` only. Commands need the same origin, a CSRF token and JSON of 16 KiB or less. | `src/dashboard/main.mjs:35`; `src/dashboard/server.mjs:39-40`, `:60-69`, `:79-80` |
| Secret-like paths | One pattern, shared with EP's `projectPath`, rejects `.env*`, `.git`, `.ssh`, keys, certificates and credential or secret files. | `scripts/lib/worker-context.mjs:36-40`, `:47-56` |

**What this means:** today a project *is* a GitHub repository, and a project without GitHub cannot be expressed anywhere: not in the campaign, not in `config.json`, and not in EP.

## 3. The project record

### 3.1 Fields

A project is a row in the supervisor store. It holds no credentials and no secret values.

| Field | Meaning and rule |
| --- | --- |
| `id` | Stable, owner-scoped project id. Set once at connect, from a short name the owner can edit before saving: lowercase, `^[a-z0-9][a-z0-9-]{1,39}$`, unique in this store. **It never changes**: not when the folder moves, the remote changes or the display name changes. After disconnect the id is kept as a tombstone and is never reused, so old work history cannot attach to a new folder. |
| `tenant_id` | The owner scope, for example `netbka`, as in campaign `target.tenantId` (`src/supervisor/campaign.mjs:108`). Together with `id` it is the project's identity. |
| `name` | Display name, at most 80 characters. The owner can change it. |
| `source_kind` | `github`, `local-git` or `folder`. It changes only through an explicit owner action, *Change connection type*, never as a side effect of a check. |
| `root_path` | Canonical root: `realpathSync.native` of the chosen folder. It is shown only in the owner's local dashboard. |
| `root_key` | The comparison key: `root_path` with `\` changed to `/` and, on Windows, lowercased. All overlap and duplicate checks use it. |
| `root_file_id` | `sha256(dev:ino)` from a bigint `stat` of the root, as the store already does for its own file (`src/supervisor/store.mjs:108-113`). It shows when a folder at the same path was replaced. |
| `fingerprint` | What makes this the *same* project. `github`: `owner/name`. `local-git`: the sorted root commit SHAs of the chosen branch (`git rev-list --max-parents=0`). `folder`: null, because a folder has nothing AIWorks may mark; moves are confirmed by the owner (section 4.6). |
| `github_repository`, `base_branch` | Only for `github`. `owner/name` with no URL, user info or token. |
| `local_branch` | Only for `local-git`: the branch AIWorks reads. |
| `mirror_root` | Only for `local-git` and `folder`: AIWorks's managed copy (section 5). It is never inside the source root, and the source root is never inside it. |
| `worktree_root` | Where task worktrees go. For `github` it comes from today's config (section 6). |
| `exclusions` | Only for `folder`: extra relative paths the owner chose to leave out (section 4.4). |
| `governance` | The governance binding: `{ kind: "registry", entryId, entryDigest, governanceRevision }`, `{ kind: "overlay", overlayId, entryDigest, governanceRevision }` (section 7), or `{ kind: "none" }`. `governanceRevision` is the governance checkout's `HEAD` at the last check. |
| `status`, `reason` | One of the four statuses (section 3.3) and a reason code from section 4. |
| `capabilities` | Checked flags: `plan` (read-only planning), `startWork` (dispatch allowed), `publish` (GitHub PR) or `apply` (local result, [#13](https://github.com/netbka/aiworks/issues/13)). Each has a reason when false. |
| `current_baseline` | Only for `local-git` and `folder`: the baseline that new work starts from (section 5.3). |
| `last_preflight` | Codes, counts and at most 10 example relative paths. Never file contents. |
| `version`, `created_at`, `updated_at`, `disconnected_at` | Compare-and-swap and tombstone fields, as for campaigns. |

### 3.2 Where it is stored

**Decision:** additive SQLite tables in the existing `supervisor.db`, not a new file and not `config.json`.

- The store is already the single mutation boundary with compare-and-swap (`src/supervisor/store.mjs:1-4`, `:157-165`). The owner and the dashboard can act on a project at the same time, and a JSON file would need its own locking.
- Adding tables keeps the store version, exactly as the owner-intervention tables do (`src/supervisor/store.mjs:180-181`). Older code ignores the new tables.
- `config.json` is the owner's hand-edited host configuration, read when `serve` starts (`src/supervisor/cli.mjs:98`). It stays the place for executable paths and the governance root. AIWorks never writes it.

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

Project events go to the existing `journal` table with `campaign_id` null and kind `project-*` (`src/supervisor/store.mjs:54-55`). The kinds are connected, preflight changed, baseline taken, relocated, disconnected, overlay approved and overlay revoked.

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
- The path is refused when it is relative, empty, longer than 1024 characters or contains control characters. UNC (`\\server\share`) and device paths (`\\?\`, `\\.\`) are refused too. Whether `realpathSync.native` turns a mapped network drive letter into a UNC path is **unknown**. The full check refuses any canonical root that starts with `\\`, and slice S2 tests this on HomePc.
- **Canonical root:** `realpathSync.native(input)`. When it differs from the input (a symlink, junction or `subst` drive), the owner sees both paths and confirms the real one. Only the real path is stored.
- **Protected roots are refused:** a drive root; `%SystemRoot%`; `%ProgramFiles%` and `%ProgramFiles(x86)%`; the user profile root itself; and the AIWorks checkout, its `.local` directory, the data directory, the governance root, every configured `worktreeRoot` and every `mirror_root`, including anything inside them.
- **Overlap:** a root equal to, inside, or containing a live project's `root_key` is refused. An equal key means the folder is already connected (section 4.6).

### 4.2 Telling the kinds apart

Git is always run with `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks`, so `git status` cannot rewrite the index. AIWorks also passes `-c core.fsmonitor=false`, so a repository's own configuration cannot start an fsmonitor command. This is a per-command setting and writes no configuration. It never writes Git configuration and never adds `safe.directory`. (Workers already get a per-command `safe.directory` only for their own worktree: `src/supervisor/adapters/executors.mjs:190`.)

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
4. The owner may switch an unregistered GitHub checkout to **Local Git**. AIWorks then ignores the remote and never pushes. A checkout whose `owner/name` *is* in the EP registry must connect as **GitHub**, so that one repository never has two governance bindings.

### 4.3 Links, nested repositories and Windows case

These rules are for `folder` scans and for the `local-git` uncommitted-change notice. For Git kinds, only committed content reaches a worktree, so links and nested repositories follow Git's own behaviour, as they do today.

- **Links are never followed.** The scan uses `lstat`. Symbolic links and junctions (Node reports a junction as a symbolic link on Windows; slice S2 tests this) are left out and listed, whether their target is inside the root or outside it. A mirror that contains no links cannot be used to reach anything outside the folder.
- **Hard links** (`nlink > 1`) are copied by content and counted in the notice. Copying breaks the link inside the mirror only. Apply ([#13](https://github.com/netbka/aiworks/issues/13)) must treat them as a conflict class.
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

`mirror_root = <dirname(dataDir)>/mirrors/<projectId>/`. On HomePc that is `D:/Git/aiworks/.local/mirrors/<id>` (planned), next to `worktrees/` ([SUPERVISOR.md §6](../SUPERVISOR.md#6-running-on-homepc)). Connect checks that it is outside the source root and that the source root is outside it. `mirrors/` is under the already-ignored `.local/`.

### 5.2 Shape

- **Local Git:** `git init --bare <mirror_root>/repo.git`, then, inside the mirror, `git fetch --no-tags <root> +refs/heads/<local_branch>:refs/heads/source/<local_branch>`. The fetch reads the owner's repository and writes only into the mirror. *Refresh* repeats the same fetch. The owner's `.git` gets no worktree records, branches or configuration. Uncommitted owner changes are not included, and the dashboard says so (`UNCOMMITTED_NOTICE`).
- **Plain folder:** `<mirror_root>/snapshot/` is a normal Git repository that AIWorks owns. Its work tree is AIWorks's *copy*, never the source. Import syncs included files from the source into `snapshot/` (it reads the source and writes only the copy), removes copies of files that are gone from the source, then runs `git add -A` and commits on branch `aiworks/baseline` with `-c user.name="AIWorks" -c user.email=aiworks@localhost`. The repository's own `info/attributes` is `* -text -eol -filter -ident`, so content is stored byte for byte. Its hooks path is empty.
- Workers never get `mirror_root`. Task worktrees are created from the mirror with the existing adapter, `prepareImplementWorkspace({ repoPath: <mirror repo>, baseSha: <baseline commit> })`. The explicit `baseSha` skips the `fetch origin` (`src/supervisor/adapters/git.mjs:33`), so no remote is needed. Verification uses `prepareVerifyWorkspace` unchanged. `pushVerified` (`:81-85`) is never called for local kinds. Their result is a local revision plus evidence, never a fake PR ([#8](https://github.com/netbka/aiworks/issues/8)).

### 5.3 The baseline it binds

A **baseline** is one row in `project_baselines`:

- the mirror commit SHA;
- `manifest_digest`, the SHA-256 of the canonical JSON of the sorted `[relativePath, size, sha256, binary]` list;
- file and byte counts;
- the excluded-path summary.

For `local-git` the manifest is the commit's tree, and `manifest_digest` is the commit SHA.

- Connect takes baseline 1. A new baseline is taken only when the owner chooses *Refresh from folder*, or when the work-envelope flow ([#8](https://github.com/netbka/aiworks/issues/8)) asks for one before planning. There is no background re-import.
- Work binds to a baseline commit as its base SHA. The task packet's `revision` already carries a full SHA, so the packet format does not change.
- **Apply** belongs to [#13](https://github.com/netbka/aiworks/issues/13) and #8, not here. It must rescan the source and compare it with the bound baseline's manifest, and stop on any change to a path the result touches. The manifest is what makes that check possible.
- If the mirror's `aiworks/baseline` head is not the recorded commit, the result is *Needs setup* (`MIRROR_CHANGED`). The owner chooses *Rebuild copy*, which re-imports into a fresh mirror and takes a new baseline. Old task worktrees and evidence are kept.

## 6. How `config.json` and the registration gate change

### 6.1 `config.json` `repositories`

- It stays readable and keeps working for every existing GitHub campaign. AIWorks never writes it.
- **Resolution, planned for `Controller.repo()`** (`src/supervisor/controller.mjs:542-546`):
  1. Look for a live project with `github_repository` equal to the campaign's `target.repository`, ignoring case.
  2. If there is none, use `config.repositories[...]`, as today.
  3. If both exist and their canonical paths or worktree roots differ, raise a B2 `project-connection` blocker with the `CONFIG_CONFLICT` copy and dispatch nothing. AIWorks never picks one.
- **Import:** for every `config.repositories` entry with no project, the dashboard offers *Add as project*. That runs the normal GitHub connect flow on `path` and reuses its `worktreeRoot`. Nothing is imported without the owner's click, so a stale entry cannot silently become a project.
- The dashboard's `configuredRepositories` (`src/dashboard/roadmap.mjs:24-29`) adds the `github_repository` of live projects, so their GitHub metadata is fetched in the same way.

### 6.2 `assertRegisteredTarget` and `projectGovernance`

- **GitHub projects keep the current gate exactly.** That means the same registry match (`src/supervisor/campaign.mjs:239-243`), the same refusal of none or several entries (`:263-264`), the same schema validation (`:266-270`) and the same policy derivation (`:277-287`). Connect calls the same code, so a project that shows *Ready* would also pass the registration gate. Connect then stores `entryId` and `entryDigest`. When the entry changes, the next light check reports `REGISTRY_CHANGED`, re-resolves, and keeps *Ready* if it is still valid.
- **Planned refactor, with the same behaviour:** move the body of `projectGovernance` into `governanceForContract(contract, root)`, so the registry path and the overlay path (section 7) share one policy derivation. Then:
  - `projectGovernance(repository, root)` = registry match + `governanceForContract`;
  - `overlayGovernance(overlayId, root, store)` = overlay validation (section 7.4) + `governanceForContract`, with `exceptions: []`.
- `assertRegisteredTarget` does not change in this design. A campaign for a local project needs a declaration format without `target.repository` and a GitHub-free authorization (`src/supervisor/campaign.mjs:100`, `:109`). Both belong to D4 and [#8](https://github.com/netbka/aiworks/issues/8). Until D4 is decided and built, `startWork` stays false for `local-git` and `folder` because of a code constant, `LOCAL_ADMISSION = false`, not a setting. Turning it on is a reviewed code change that names D2 and D4. No `config.json` key enables it.

## 7. Decision D2: local projects in Engineering Platform's governance

### 7.1 The problem

Registry membership *is* governance inheritance (EP [GOVERNANCE_INHERITANCE.md §1](https://github.com/netbka/engineering-platform/blob/main/docs/GOVERNANCE_INHERITANCE.md#1-what-every-project-inherits)). A registry entry needs `repository.github` (section 2). So a folder without GitHub cannot inherit governance, and adding each folder through an EP pull request defeats D1. Skipping the check is not allowed.

### 7.2 The proposal in one paragraph

EP approves the **mechanism once**. A registered host project (AIWorks) may keep an owner-approved *local overlay* of project entries in its own data directory. Each overlay entry must validate against a new EP schema that **can only add or tighten rules**. It has no exceptions, no release authorization, no environment other than `local`, and its independent verification gate is enabled. An overlay entry inherits every portfolio policy and the whole baseline, exactly as a registry entry does. The overlay never lives in the governance checkout and AIWorks never writes there.

### 7.3 Proposed EP change, as text

This is to be opened by the owner, or by an agent working in EP, as one EP pull request. AIWorks does not open it.

**(a) `schemas/project-contract.schema.json`**

1. Reserve the `lp-` id prefix for overlay entries, so they can never collide with registry ids. On EP main (observed with `gh api`) no registry id starts with `lp-`. (`local-commander` exists, which is why the prefix is not `local-`.)
   ```json
   "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]*$", "not": { "pattern": "^lp-" } }
   ```
2. Add an optional top-level `localProjects` block. Its presence on a registry entry is the one-time approval for that host:
   ```json
   "localProjects": { "$ref": "#/$defs/localProjectHost" }
   ```
   ```json
   "localProjectHost": {
     "$comment": "This registered project may admit owner-approved local projects through a local overlay (GOVERNANCE_INHERITANCE.md section 11). Removing the block revokes every overlay entry it hosts.",
     "type": "object",
     "required": ["overlay", "approval", "source", "summary"],
     "properties": {
       "overlay": { "const": "local-project-overlay@1" },
       "approval": { "type": "string", "pattern": "^https://github\\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/(issues|pull)/[0-9]+$" },
       "source": { "$ref": "#/$defs/projectPath" },
       "summary": { "$ref": "#/$defs/label" }
     },
     "additionalProperties": false
   }
   ```
3. A schema condition: if `localProjects` is present, `capabilities` must contain `worker`.

**(b) New `schemas/local-project-overlay.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://engineering-platform.local/schemas/local-project-overlay.schema.json",
  "title": "Local Project Overlay Entry",
  "type": "object",
  "required": ["id", "name", "host", "source", "lifecycle", "capabilities", "environments", "governance", "approval", "reviewBy"],
  "properties": {
    "id": { "type": "string", "pattern": "^lp-[a-z0-9][a-z0-9-]{0,38}$" },
    "name": { "type": "string", "minLength": 1, "maxLength": 80 },
    "host": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]*$" },
    "source": {
      "type": "object", "required": ["kind"],
      "properties": { "kind": { "enum": ["local-git", "folder"] } },
      "additionalProperties": false
    },
    "lifecycle": { "enum": ["active", "experimental", "parked"] },
    "capabilities": { "$ref": "project-contract.schema.json#/properties/capabilities" },
    "environments": { "const": ["local"] },
    "governance": {
      "type": "object",
      "required": ["observedAt", "parentLink", "independentVerificationGate"],
      "properties": {
        "observedAt": { "type": "string", "pattern": "^local:lp-[a-z0-9][a-z0-9-]{0,38}@(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$" },
        "parentLink": { "enum": ["linked", "absent", "unknown"] },
        "authorities": { "$ref": "project-contract.schema.json#/$defs/governance/properties/authorities" },
        "ownerReserved": { "$ref": "project-contract.schema.json#/$defs/governance/properties/ownerReserved" },
        "stricter": { "$ref": "project-contract.schema.json#/$defs/governance/properties/stricter" },
        "gaps": { "$ref": "project-contract.schema.json#/$defs/governance/properties/gaps" },
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
  "additionalProperties": false
}
```

What the schema leaves out, on purpose: `repository`, `resources`, `secrets`, `notes`, `governance.exceptions` and `governance.releaseAuthorization`. A gap's `request` stays a GitHub URL under the existing `governanceGap` definition. A local project that needs to record a gap therefore has a GitHub issue somewhere, such as AIWorks's own. A gap waives nothing, so this costs nothing.

**(c) New section 11, "Local project overlay", in `docs/GOVERNANCE_INHERITANCE.md`.** It states these rules, which the schema cannot express. The host enforces them, and EP's fixtures test them where they can.

1. **Membership is inheritance.** An admitted overlay entry is governed exactly like a registry entry (§1): the Constitution with its baseline, the portfolio decisions and every portfolio policy that applies. No field declines any of them.
2. **One-time host approval.** An overlay entry is admissible only while its `host` registry entry declares `localProjects.overlay` equal to `local-project-overlay@1` and has the `worker` capability. If the block is removed, every entry it hosts stops being admissible at the host's next read.
3. **Disjoint identity.** `id` starts with `lp-`, which registry ids may not. Each id is unique within a host and is never reused.
4. **Add or tighten only.** There are no exceptions and no release authorization. `environments` is `["local"]`. `independentVerificationGate` is `enabled`. A project that needs any of these is registered in `registry/projects/` through an EP pull request. That is a new identity; the host may link the two with the owner's confirmation.
5. **Owner approval, bound.** Only the owner creates or renews an entry, through the host's local owner channel. Agents, workers and coordinators of the host cannot write overlay entries. `approval.digest` is the SHA-256 of the canonical JSON of the entry without `approval`, so any later edit invalidates the approval.
6. **Expiry.** `reviewBy` is at most 365 days after `approval.at`. After `reviewBy` the entry is not admissible until the owner renews it. This is stricter than an exception, which only fails validation.
7. **Never in the governance checkout.** Overlay entries live in the host's own state. Hosts read EP read-only and never write the checkout.
8. **Same packet values.** Workers receive the same values as for a registry entry (§9): the id, the policy ids from the catalog, the authorities, and the ids and rules of any gaps. Exceptions are always empty.
9. **Visibility.** EP's conformance report cannot see local overlays. The host shows every overlay entry, its expiry and its host-approval state to the owner.

**(d) EP fixtures.** Valid fixtures: a host block on a `worker` project, and a minimal overlay entry. Invalid fixtures, each failing at its recorded location:
- a registry id starting with `lp-`;
- a host block without `worker`;
- an overlay entry with `exceptions`, `releaseAuthorization`, `environments: ["prod"]`, gate `not-enabled`, an id without `lp-`, a secret-like authority path (`.env`), `repository`, or a missing `approval`;
- `observedAt` in GitHub form.

### 7.4 What AIWorks enforces (planned, in slices S7 and S8)

- **Validation.** Each entry is validated at every admission and dispatch against `schemas/local-project-overlay.schema.json` read from the governance root, compiled once per root like the contract schema (`src/supervisor/campaign.mjs:15-22`). If the schema file is missing, which is the case until EP merges the change, every overlay is inert and the result is `RULES_UNAVAILABLE`. The design fails closed and is switched off by construction.
- **Rules 2 to 6** are checked in code: host block, `lp-` prefix and uniqueness against the registry, digest, `reviewBy`.
- **Who may write.** Entries are written only by the dashboard's owner command path, which is local and protected by CSRF (`src/dashboard/server.mjs:39-40`, `:60-64`). The owner must type the project name to confirm. No supervisor, worker or coordinator code path writes `project_overlays`.
- **Revocation.** A revoked or expired entry raises the B2 `project-governance` blocker on dispatch, with the same behaviour as today's governance failure (`src/supervisor/controller.mjs:603-608`).

### 7.5 Threats D2 closes

| Threat | Closed by |
| --- | --- |
| A local project claims a registered project's rules, or hides under its name | Disjoint `lp-` ids; GitHub kind required for registered repositories (section 4.2); the refusal of several matches is kept (`campaign.mjs:264`) |
| An overlay drops a portfolio policy | Overlay entries list no policies. Policies are derived from EP's catalog by the same code as registry entries. |
| An overlay smuggles in an exception or release authority | The schema has no `exceptions` and no `releaseAuthorization`; `environments` is `local` only |
| Independent verification is turned off | `independentVerificationGate` is `const: "enabled"` |
| An agent registers its own project, or widens one | Only the owner command path writes overlays; the digest binds the approved content |
| A stale approval lives forever | `reviewBy` of at most 365 days; inadmissible after it |
| EP wants to stop local admission | Removing the host block revokes every overlay entry at the next read |
| The governance checkout is changed | Overlays live in the AIWorks store; the checkout stays read-only |
| A worker is pointed at a secret file | Authority paths use EP's `projectPath` and its secret-like exclusion |

D2 waives no EP policy, and nothing in it writes the governance checkout.

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
| `GOVERNANCE_ROOT_MISSING` | Needs setup | AIWorks can't read the project rules from Engineering Platform. Set up the rules folder in Settings. | Open Settings |
| `GIT_CLI_MISSING` | Needs setup | AIWorks can't find Git on this computer. Set the Git path in Settings. | Open Settings |

### 8.2 GitHub project

**Flow:**
1. Path checks (section 4.1).
2. Git detection gives `origin` = `owner/name`.
3. `gh auth status`, then `gh repo view owner/name --json nameWithOwner,defaultBranchRef,viewerPermission` (read-only).
4. Exactly one EP registry entry via the existing match (section 6.2).
5. Base branch: the default is GitHub's default branch, and the owner can change it. It is checked with `git ls-remote --heads origin <branch>`, which reads only.
6. `worktree_root` defaults to `<dirname(dataDir)>/worktrees/<name>`, the layout in [SUPERVISOR.md §6](../SUPERVISOR.md#6-running-on-homepc).
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
| `REGISTRY_MISSING` | Needs setup | {repo} isn't in Engineering Platform's project list, so AIWorks can plan but not start work. Add it there, then check again. | Check again |
| `REGISTRY_AMBIGUOUS` | Needs setup | Engineering Platform lists {repo} more than once ({ids}). AIWorks won't guess which rules apply. | Check again |
| `REGISTRY_INVALID` | Needs setup | Engineering Platform's entry for {repo} has an error, so AIWorks can't read its rules. | Check again |
| `REGISTRY_CHANGED` | Ready, or the code above | (Notice) The project rules for {repo} changed in Engineering Platform. AIWorks uses the new rules. | — |
| `CONFIG_CONFLICT` | Needs setup | Settings point {repo} to {configPath}, but this project is at {root}. Remove one so AIWorks doesn't guess. | Open Settings |
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
| `RULES_UNAVAILABLE` | Needs setup | Engineering Platform doesn't allow projects without GitHub yet, so this project has no rules to work under. | — |
| `RULES_NEED_APPROVAL` | Needs setup | Review and approve this project's rules to let AIWorks work here. | Review rules |
| `RULES_EXPIRED` | Needs setup | Your approval of this project's rules ended on {date}. Review it again to continue. | Review rules |
| `RULES_REVOKED` | Needs setup | Engineering Platform no longer allows projects without GitHub. Work can't start here until that changes. | — |

`RULES_*` appear only after slice S7. Until then, local projects show `LOCAL_START_OFF`.

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

The *Add project* screen and the project list follow the owner-workspace design ([#11](https://github.com/netbka/aiworks/issues/11), `docs/design/OWNER_WORKSPACE.md`, which another task writes). This design supplies the API and the copy above. The acceptance comes from EP UX-001 and UX-002, which are linked and not restated here:
- keyboard-only connect;
- 320px width without horizontal scroll;
- a label for every field;
- the status announced to screen readers;
- one primary action per state.

## 9. Owner-reserved questions

D1, D3, D5 and D9 are settled and are not asked again. D4 (AW-005 local admission) is designed by [#8](https://github.com/netbka/aiworks/issues/8) and is not asked here.

1. **Approve the Engineering Platform change in section 7 (D2)?** It adds a second way to inherit portfolio governance: a local overlay that can only add or tighten rules. Changing how governance is established in EP is the owner's call ([EP Constitution §2](https://github.com/netbka/engineering-platform/blob/main/docs/CONSTITUTION.md#2-owner-role); GOVERNANCE_INHERITANCE.md introduction).
   *Recommended answer:* **yes**, as written, including the `localProjects` block on AIWorks's own registry entry.
   *Unblocks:* slices S7 and S8, and with D4, starting work on projects without GitHub.
2. **Is a typed confirmation in the local dashboard enough owner approval for one local project's rules?** It would be the approval method `owner-local-ui` in section 7.3, valid for up to 12 months and bound to the exact entry by digest. This defines what counts as owner approval for a governance entry, so it is owner-reserved.
   *Recommended answer:* **yes**. The dashboard is local-only ([AW-003](../DECISIONS.md#aw-003---the-operations-dashboard-is-local-only)) with origin and CSRF checks, and starting any work still needs its own authorization under D4.
   *Unblocks:* slice S8.

The following are decided here and are not owner questions:
- the storage choice (section 3.2);
- the size limits (section 4.5);
- the mirror location (section 5.1);
- refusing network folders and nested projects;
- leaving out links;
- allowing an unregistered GitHub checkout to connect as Local Git.

## 10. Implementation slices

Each slice is one reviewable PR. Every change under `src/supervisor/` needs independent approval of the exact head commit (AGENTS.md). The [#5](https://github.com/netbka/aiworks/issues/5) and [#6](https://github.com/netbka/aiworks/issues/6) owners have priority on `api.mjs` and `campaign.mjs`. All tests are synthetic: temporary folders, disposable Git repositories and synthetic `git`/`gh` wrappers. They make no network, model or GitHub calls. Each slice ends with `npm run check`. Merged is not deployed: the live runtime changes only through the upgrade procedure.

| # | Outcome | Files it owns | Tests | Acceptance | Depends on | Waits for a decision |
| --- | --- | --- | --- | --- | --- | --- |
| **S1** | Project records exist and survive restarts | `src/supervisor/projects.mjs` (new); `src/supervisor/store.mjs` (additive DDL only) | `tests/supervisor/projects.test.mjs`: an old store gains the tables with the store version unchanged; compare-and-swap conflict; id rules; tombstone ids never reused; unique live root and GitHub repository; a remote URL with user info is stored as `owner/name` only; journal entries | Records can be created, read and disconnected through the module; no other behaviour changes | — | No |
| **S2** | Read-only preflight tells the three kinds apart | `src/supervisor/project-preflight.mjs` (new) | `tests/supervisor/project-preflight.test.mjs`: every path code in 8.1; Git detection codes; the junction is reported as a link; case collision; limits; the source snapshot is unchanged, including `.git`; Git commands carry `--no-optional-locks`; no write commands are issued | Every row of 8.1 and the detection rows of 8.2 to 8.4 return their code; the snapshot equality test passes | S1 | No |
| **S3** | GitHub projects connect, and campaigns resolve their checkout through them | `src/supervisor/project-connect.mjs` (new); `src/supervisor/controller.mjs` (`repo()` only); `src/supervisor/campaign.mjs` (extract `governanceForContract`, same behaviour) | `tests/supervisor/project-github.test.mjs`; the existing `campaign-registry` and `packet-governance` tests stay unchanged and pass | 8.2 complete; `CONFIG_CONFLICT` blocks dispatch; existing campaigns run unchanged | S1, S2; #5 and #6 for `campaign.mjs` | No |
| **S4** | Local Git projects connect with a managed mirror | `src/supervisor/adapters/mirror.mjs` (new, local-Git part); `src/supervisor/project-connect.mjs` | `tests/supervisor/project-local-git.test.mjs` (8.3 list) | 8.3 complete; `startWork` false with `LOCAL_START_OFF`; the owner's `.git` is untouched | S1, S2 | No (dispatch waits for D2 and D4) |
| **S5** | Plain folders connect with a managed snapshot and baselines | `src/supervisor/adapters/mirror.mjs` (folder part) | `tests/supervisor/project-folder.test.mjs` (8.4 list) | 8.4 complete; the source is byte-identical after connect, refresh and rebuild; secret-like files are absent from the mirror's objects | S1, S2, S4 | No |
| **S6** | The owner adds and sees projects in the dashboard | `src/dashboard/projects.mjs` (new); `src/dashboard/server.mjs` (routes `GET /api/projects`, `POST /api/projects/preflight`, `/connect`, `/check`, `/relocate`, `/disconnect`, with the same origin, CSRF and 16 KiB rules); `src/dashboard/public/*` (the Projects area only); `docs/OPERATIONS_DASHBOARD.md` | `tests/dashboard/projects.test.mjs`: route security (origin, CSRF, size); exact copy for each code; no absolute path in any response except the owner's own project root; the two-project acceptance (8.5); keyboard and 320px checks per UX-001/UX-002 | 8.5 and 8.6 pass; the blind owner review from #11 has run | S3, S4, S5; the DS-WORKSPACE design (#11) | No |
| **S7** | The AIWorks side of D2: overlay entries are validated, and inert until EP has the schema | `src/supervisor/local-overlay.mjs` (new); `src/supervisor/campaign.mjs` (`overlayGovernance`); `tests/fixtures/governance-overlay/` (copy of EP's **merged** schema) | `tests/supervisor/local-overlay.test.mjs`: missing schema gives `RULES_UNAVAILABLE`; no host block gives `RULES_REVOKED`; `lp-` prefix and collision; digest mismatch; expired `reviewBy`; exceptions refused; policies equal to the registry derivation for the same capabilities | Rules 2 to 6 of 7.3(c) enforced; `LOCAL_ADMISSION` stays `false` | S1, S4 | **Yes:** EP merge of the 7.3 change (owner question 1) |
| **S8** | The owner approves and renews a local project's rules | `src/dashboard/projects.mjs`; `src/dashboard/public/*` (rules review screen) | Typed confirmation is required; only the owner route writes `project_overlays`; renewal changes the digest; the entry is revoked when the host block disappears | `RULES_*` copy shown; no worker or coordinator path can write overlays (asserted by a code search test and by route tests) | S6, S7 | **Yes:** owner question 2 |

Starting work on local projects, which means turning `LOCAL_ADMISSION` on, is not a slice of #7. It belongs to [#8](https://github.com/netbka/aiworks/issues/8) after D2 (S7) and D4 are both accepted. Apply to the owner's folder belongs to [#13](https://github.com/netbka/aiworks/issues/13) and #8, and uses the baselines from S5.
