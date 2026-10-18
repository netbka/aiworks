# Public release and deferred showcase

Prepared 13 October 2026 for [documentation #98](https://github.com/netbka/aiworks/issues/98). This is a readiness checklist, not a declaration that the repository is already public or licensed as open source.

## Work that can happen now

The English README, installation/configuration guides, manual and AI-assisted first-task instructions, inert JSON examples, contribution/security guidance and issue/PR templates can be reviewed independently of the dashboard layout. Keep ongoing #7/#8/#11 work moving. Do not create a second runtime or duplicate their implementation.

## Before a public source release

- [ ] Audit code/asset/documentation provenance and direct/transitive dependency licenses. Select an appropriate license with the owner and retain required third-party notices. A public repository without a suitable license is not the promised open-source release.
- [ ] Inspect the proposed public content and complete history, tags, branches, issues/PRs, workflow logs/artifacts and attachments for secrets and private operational data. Rotate exposed credentials; removing the current file alone is not remediation. Choose the appropriate public-history strategy without discarding attribution.
- [ ] Separate personal campaigns, credentials, run data and project rules from redistributable product code. No user submits private project tasks to public upstream as normal operation.
- [ ] Rehearse a new-user installation with the bundled governance starter (`npm run setup:local`), owner-controlled local project registration and a separately approved plan. No maintainer-private repository is required; preserve real authorization and isolation rather than using test fixtures.
- [ ] Verify one new-user Windows installation from the written guide, one read-only report, one small code task, independent verification, real result/CI evidence and a stop/restart rehearsal. Record exact versions and failures, not estimated savings.
- [ ] Configure and test external-PR safeguards: isolated hosted runners, least-privilege tokens, no provider/production secrets, pinned actions, appropriate outside-workflow approvals, protected integration and a separate release path. Never attach the owner's persistent computer to untrusted public PR execution.
- [ ] Enable and test a private security reporting route. State maintenance/support expectations without inventing an SLA.
- [ ] Resolve public links and supported-platform claims at the release revision. Clearly distinguish implemented, enabled, verified and roadmap capabilities.

Repository visibility, licensing, secrets, branch rules and provider settings are unchanged by the documentation PR. This checklist must not block unrelated internal work.

## Deferred website: do not build yet

The owner explicitly asked to wait until the ongoing layout/dashboard work is finished, then build a page that shows it off. The executable follow-up is [issue #99](https://github.com/netbka/aiworks/issues/99), linked to [dashboard #11](https://github.com/netbka/aiworks/issues/11) and [delivery program #14](https://github.com/netbka/aiworks/issues/14).

Before beginning the site, verify that the relevant layout changes and blocking review fixes are merged, independent UX acceptance names the exact finished revision, and that revision is demonstrated in an approved local/disposable runtime. A closed issue, completed PR or unit-test pass alone does not establish visual/behavioral acceptance. The gate can be satisfied by a clear maintainer acceptance of the finished showcase scope while unrelated future dashboard enhancements remain open.

**Until then:** no site/ implementation, Pages deployment workflow, final promotional screenshot, fabricated UI or live-dashboard exposure. Writing this readiness brief is not starting the website.

**Afterwards:** prepare a separate PR with a small English static site under site/, using the completed product styling and sanitized screenshots/demo. Include purpose, audience, actual supported features, limitations, Get started, GitHub and a development story. Link these guides rather than duplicating them. Do not buy a domain or add paid hosting. Prepare GitHub Pages configuration only at that stage; public deployment additionally requires the source-release checklist above.

## Keep materials truthful while development continues

At every release, update the supported setup path and its examples from the exact code being shipped. Do not advertise folder execution, a startup MCP API, automatic scope expansion, release automation or a provider integration merely because it appears in a design. Do not claim cost/throughput improvements without comparable runtime receipts.

The website and README are not the runtime dashboard. They must not reveal machine names, absolute personal paths, secret values, customer content, internal operational campaigns or private links in public screenshots. Review every selected asset before publication.
