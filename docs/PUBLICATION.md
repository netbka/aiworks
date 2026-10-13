# Preparing a public repository

Public source contains reusable code, documentation and synthetic fixtures. Private campaigns and installation files are ignored, and the public-scope check rejects them from Git's index. An explicit force-add can override `.gitignore`, so the check is part of `npm run check`.

Removing tracked files does not erase previous commits. Before changing an existing repository's visibility, prepare a separately reviewed clean publication history or a fresh repository from an audited source snapshot. A normal cleanup commit leaves earlier campaign blobs, commit messages, author metadata and old branches reachable.

Repository publication also exposes issues, pull requests, comments, attachments, releases and other metadata. Review these separately; a clean code snapshot does not sanitize them. Do not change visibility, force-push rewritten history or delete remote records as part of a source cleanup without explicit authorization for that concrete action.

## Private files

Keep operational declarations under ignored `campaigns/`, `.local/campaigns/` or outside the checkout. Keep actual governance, connected-project inventories, config, SQLite state, worker packets, logs, screenshots and backups outside the public tree. Never use real campaign records as fixtures.

## Checks

Run `npm run check`, review the staged file list and inspect the complete proposed public snapshot. Privacy checks must inspect the proposed content without printing secret values. Synthetic examples must use fictional organizations, repositories, paths and identities.

The public-scope check catches excluded paths and sensitive file types. It cannot establish that arbitrary prose, comments or GitHub metadata are free of confidential information; publication still needs a content and history review.
