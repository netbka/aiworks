# Preparing a public repository

Public source contains reusable code, documentation and synthetic fixtures. All installation-specific data belongs under ignored `.local/`: project registries, governance, campaigns, approvals, machine configuration, logs, reports, screenshots and backups. Never include it in public issues, pull requests, comments or commit messages. An explicit force-add can override `.gitignore`, so the public-scope check is part of `npm run check` and the installed pre-commit hook.

Removing tracked files does not erase previous commits. Before changing an existing repository's visibility, prepare a separately reviewed clean publication history or a fresh repository from an audited source snapshot. A normal cleanup commit leaves earlier campaign blobs, commit messages, author metadata and old branches reachable.

Repository publication also exposes issues, pull requests, comments, attachments, releases and other metadata. Review these separately; a clean code snapshot does not sanitize them. Do not change visibility, force-push rewritten history or delete remote records as part of a source cleanup without explicit authorization for that concrete action.

## Private files

Keep declarations under `.local/campaigns/`, governance under `.local/governance/`, and runtime state under `.local/supervisor/`. Legacy ignored paths remain supported, but new installation data goes under `.local/`. Never use real campaign records as fixtures. `npm run setup:local` creates the redistributable governance starter without registering or authorizing a project and refuses to replace existing governance.

## Checks

Run `npm run check`, review the staged file list and inspect the complete proposed public snapshot. Privacy checks must inspect the proposed content without printing secret values. Synthetic examples must use fictional organizations, repositories, paths and identities.

`npm install` installs the repository's pre-commit and pre-push privacy hooks. Existing custom hooks are preserved; chain these checks into them before publishing. The staged-content check rejects private paths, common credential formats, personal installation paths and references to the upstream owner's other repositories. It reads Git's index, so cleaning the working file alone cannot conceal staged content. The push hook also checks new commit messages and intermediate trees, including disclosures deleted in a later commit. It checks new commits relative to the destination and the full ancestry for a new branch or tag. It also checks filenames, ref names and tag annotations; tags must resolve to commits. It does not certify already-published destination history.

Keep installation-specific names out of the public rules too. An optional ignored `.local/publication.json` holds `{"privateTerms":["fictional-private-project","fictional-private-host"]}` for local text checks. Use your actual private identifiers only in that local file. Findings print neither the matched values nor private filenames. Tests construct synthetic credential shapes at runtime rather than placing complete token-shaped literals in source.

Hooks and pattern scanners are additional checks, not proof that arbitrary text is safe. Do not bypass them. Review source, assets, every proposed commit and public metadata before publishing. Source cleanup cannot erase existing Git objects, GitHub edit history or downloaded copies; history and remote-record cleanup require an explicit reviewed plan.
