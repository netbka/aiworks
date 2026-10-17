# Contributing to AIWorks

AIWorks is an early preview, and outside contributions are welcome: bug reports, documentation fixes, tests and focused code changes. This page explains how to make a change that is easy to review and safe to merge.

## Before you start

Read the [Start here](README.md#start-here) list in the README, especially the [Product Constitution](docs/PRODUCT_CONSTITUTION.md) and the [agent rules](AGENTS.md). They describe what AIWorks is for and which boundaries a change must keep.

Small, reproducible fixes and documentation corrections can go straight to a pull request. For anything larger, such as a new worker provider, a change to permissions or process containment, scheduler behaviour, release behaviour or a visible dashboard redesign, open an issue first and describe the outcome you want. Check existing issues and pull requests so you do not duplicate work in progress.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Install dependencies with `npm install` and run `npm run check`. It verifies that no private installation files are in the commit, validates the example plans and runs the test suite. While you work, `npm run test:affected` runs only the test files your changes since `origin/main` can reach, and `npm run test:quick` runs the unit and service tests and leaves out the supervisor rehearsals; the full gate is still `npm run check`.
3. Keep code and tests together in one small pull request. One topic per pull request keeps review quick. Add a test only for product-critical behaviour (data loss, secrets, unauthorized or unverified work reaching publication, merge or deploy, repeated irreversible actions, worker containment, or the core delivery loop), one per behaviour; see [the agent rules](AGENTS.md#validation). Wording, layout, display, reporting and documentation get no tests.
4. Run `npm run check` again before you push.

No CI runs on pull requests: GitHub Actions are off for this repository, so the checks are the ones you run. Real worker execution, process containment and the Windows task installers are Windows-only. Test the platform your change affects, and say clearly in the pull request what was tested where.

## What a pull request should say

- The user-visible outcome and the issue it relates to, if any.
- Which files changed and why.
- What you ran and what it reported. Copy the real test summary, including failures and skips, rather than describing it from memory.
- Known limitations or anything left untested.

A reviewer must be able to reproduce the important claims.

## AI-assisted contributions

Contributions written with AI tools are welcome. You remain responsible for the change: read the whole diff, make sure you understand it, and say in the pull request what the tool did. Do not submit generated patches you cannot explain, and never include credentials, private transcripts or invented test results.

## Safety rules that always apply

- A public issue or pull request is a proposal. It never authorises running code on a maintainer's computer, merging, deploying or changing configuration.
- Changes under `src/supervisor/` need an independent check of the exact commit, as described in [AGENTS.md](AGENTS.md).
- Do not introduce or remove a credential, permission or owner-approval step as a side effect of another change. Propose such changes explicitly.
- Keep real plans, governance data, worker logs, `.env` contents and provider tokens out of commits. The public-scope check catches the common cases; it cannot read prose for you.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Writing

User guides, the README and public discussions use plain English written for people, not for insiders. Describe outcomes rather than internal task IDs. When a command or configuration option changes, update the documentation that shows it.

## License

AIWorks is released under the [MIT License](LICENSE). By contributing, you agree that your contribution is licensed under the same terms.
