# Contributing to AIWorks

AIWorks is in internal preview while its public release is prepared. Documentation and these contribution guidelines do not change repository visibility, PR access settings or licensing. See [the release checklist](docs/publication/RELEASE_CHECKLIST.md) for what still needs to be completed before public contributions open.

## Start with the right change

Small documentation corrections, focused tests and reproducible narrow fixes are good first contributions. For a new provider, permissions change, scheduler redesign, release behavior or a large UI change, discuss the intended outcome in an issue first. Check existing issues, PRs and assigned work so you do not duplicate an active repair. The current dashboard/layout work is owned by its existing lane; do not redesign it as part of preparing launch materials.

AI-assisted contributions are welcome in the proposed public workflow. The contributor remains responsible for understanding the diff, checking provenance and providing reproducible evidence. Disclose what the AI/tool did where relevant to review; do not submit unexplained generated patches, copied credentials or invented test results.

## Work in an isolated checkout

Read [AGENTS.md](AGENTS.md), the [engineering reading list](README.md#start-here), the applicable project rules and the issue's scope. Keep code and tests together in a small, reviewable PR. Do not run untrusted changes or dependency scripts on the owner's working machine or against live data.

Use the committed Node dependency lockfile:

```powershell
npm ci
npm run check
```

For changes to user-guide examples:

```powershell
node --test tests/docs/getting-started.test.mjs
```

The focused test is not a substitute for the required full check. CI currently uses Linux; real worker execution has Windows-specific boundaries. Test the affected supported platform or clearly mark it untested. Do not weaken a Windows assertion just to turn Linux CI green.

## Evidence in a PR

Explain the user-visible outcome, linked issue, changed files, exact checked commit and remaining limitations. Copy test summaries from actual command output, including failures and skips. Separate source inspection, synthetic tests, CI and live runtime evidence. A reviewer must be able to reproduce the important claims.

Never say a change is deployed because it is merged. Changes under src/supervisor require independent approval of the exact head as described in AGENTS.md. Follow project review rules for other changes; public PRs are proposals, never authorization to execute on a maintainer's computer.

## Security, permissions and releases

No new credential/permission/owner-step gate is introduced through a casual refactor. Follow existing owner decisions and report a proposed authority change explicitly. Never include .env contents, provider tokens, private transcripts or customer data. Vulnerability reports use [SECURITY.md](SECURITY.md), not a public proof-of-exploit issue.

The intended public pipeline uses isolated, unprivileged checks without model/production credentials. Public PR comments, workflow names and issue bodies are untrusted input and must not automatically launch the owner's supervisor, merge, deploy or change configuration. These safeguards must be configured and verified before opening the repository; this document does not assert they are already enabled.

## Documentation and language

User guides, README, code-facing docs and public issue/PR discussions use clear English. Prefer outcomes over internal slice IDs. Update relevant guide examples when CLI/configuration behavior changes. Preserve canonical operational and governance ownership instead of duplicating policy text.

The showcase is explicitly deferred until the ongoing dashboard/layout acceptance is complete. Track it in [issue #99](https://github.com/netbka/aiworks/issues/99); do not create a site or final promotional screenshot in unrelated PRs.
