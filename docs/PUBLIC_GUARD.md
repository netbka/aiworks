# Publication guards: setup and use

AIWorks keeps private data (other projects, hosts, paths, people, screenshots) out of public GitHub repositories with two layers of hooks. This guide sets them up on a computer, checks them and explains what to do when they refuse something. [PUBLICATION.md](PUBLICATION.md) holds the rules they enforce.

| Layer | What it sees | Where it runs | Installed by |
|---|---|---|---|
| Git hooks (`.githooks/pre-commit`, `.githooks/pre-push`) | Staged content, every pushed commit, its messages, filenames and binary files | Every `git commit` and `git push` in an AIWorks checkout, from any tool | `npm install` (sets `core.hooksPath .githooks`) |
| Claude Code guard (`scripts/claude-guard/public-guard.mjs`) | The command text, files it sends (`--body-file`, `--input`), pushed commits, `--no-verify` | Every `git push` and `gh` write that Claude Code runs through Bash or PowerShell, in any project | `node scripts/claude-guard/install.mjs` |

Git hooks never see text posted with `gh` (pull request bodies, issue comments, API writes), and a `--no-verify` push skips them. The Claude Code guard covers both gaps. Neither replaces reading what you publish.

## Set up a computer

1. Clone AIWorks and run `npm install` in the checkout. This switches on the Git hooks.
2. Create `.local/publication.json` in the checkout (ignored by Git). List the private words there, and the folders that hold your other checkouts:

   ```json
   {
     "privateTerms": ["first.last@example.invalid", "fictional-private-host"],
     "repositoryRoots": ["<repos-root>"],
     "ignoreRepositories": []
   }
   ```

   Every checkout under `repositoryRoots` counts as private by name, so a project added later is covered. Put a checkout with a generic name (such as `notes`) in `ignoreRepositories`.
3. Run `node scripts/claude-guard/install.mjs` in the checkout. It:
   - copies the guard to `~/.claude/hooks/public-guard.mjs`;
   - writes `~/.claude/hooks/public-guard.json` once, pointing at this checkout's `.local/publication.json`;
   - registers the guard in `~/.claude/settings.json` under `hooks.PreToolUse`, after a dated backup of that file.
4. Restart Claude Code. Sessions that were already open do not load the new hook.
5. Run `node scripts/claude-guard/check.mjs`. It should end with `all checks passed`.

To move settings to a second computer, copy `.local/publication.json` and `~/.claude/hooks/public-guard.json` by hand (never through a repository or chat), fix the paths in them for that computer, then follow steps 1, 3, 4 and 5 there.

## Check an installation

`node scripts/claude-guard/check.mjs [--repo owner/name]` publishes nothing. It confirms:

- the guard is registered and the installed copy matches the checkout;
- the settings name at least one private term;
- this checkout's Git hooks are on.

It then feeds sample commands to the installed guard. A clean comment and a mere mention of `git push` must pass. A private term, a personal path and `--no-verify` must be refused. It tests against the checkout's `origin` by default. A private repository is left alone by the guard, so pass `--repo` with a public one to run the refusal cases. It never prints a private term. Run it after installing, after updating and whenever the guard seems not to react.

## Settings: `~/.claude/hooks/public-guard.json`

This file names private things, so it stays on the computer. [public-guard.example.json](../scripts/claude-guard/public-guard.example.json) shows its shape with fictional values.

| Field | Meaning |
|---|---|
| `termsFiles` | Files in the `.local/publication.json` format whose `privateTerms`, `repositoryRoots` and `ignoreRepositories` are read in |
| `repositoryRoots` | Folders whose checkout names are private. A folder that does not exist on this computer is skipped |
| `ignoreRepositories` | Checkout names that are not private |
| `privateTerms`, `privatePatterns` | Further private words, and regular expressions |
| `strict` | Public repositories where no `allow` entry for `"*"` applies |
| `allow` | `{"owner/repo": ["term"]}`: terms one public repository may contain; `"*"` applies to every public repository not in `strict` |
| `binaries` | Blob ids of binary files already reviewed, in addition to each repository's `.public-binaries` |

Adding to `allow` or `binaries` weakens the guard. Do it only with the owner's agreement and only for a term that really belongs in that repository.

## When the guard refuses

The refusal names the check and the kind of finding (`private term`, `personal local path`, `Claude session link`, `binary file`), not the matched text. Then:

- **Text you wrote** (a PR body, a comment): rewrite it without the private detail and run the command again.
- **A pushed commit**: fix the content in a new commit. If the private detail is in an earlier commit of the branch, rebuild the branch without it before the first push. Once published, Git objects and GitHub edit history keep it.
- **A screenshot or other binary file**: open it and confirm it shows nothing private. Then add `<blob id> <path>` to `.public-binaries` (`git rev-parse :<path>` prints the id of a staged file).
- **A false refusal** (a word that is not private in this context): tell the owner. Do not use `--no-verify`, rename things to slip past the check, or edit the guard to let one command through.

Never switch a hook off to get a publication through.

## Update and remove

- **Update** after pulling a newer guard: run `node scripts/claude-guard/install.mjs` again. It replaces the hook script and keeps your settings. Then run `check.mjs`.
- **Remove**: delete the `public-guard.mjs` entry from `hooks.PreToolUse` in `~/.claude/settings.json`, then delete `~/.claude/hooks/public-guard.*`.

## Limits

- The guard sees only commands that Claude Code runs through its Bash and PowerShell tools. Other agents and commands typed by hand pass only the Git hooks.
- AIWorks workers run with all hooks switched off (see the worker isolation section of [SUPERVISOR.md](SUPERVISOR.md)). Supervisor publications go through the supervisor's own privacy checks and the Git hooks.
- The visibility of each repository is cached for six hours. A repository whose visibility cannot be read counts as public.
- A linked worktree uses the `.local/` settings of its main checkout. If an agent tool rewrites `core.hooksPath` to an absolute path in a worktree, set it back with `git config core.hooksPath .githooks`.
