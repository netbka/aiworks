# Security

AIWorks can dispatch tools that read and change project files. Review the actual execution boundary before granting access. A natural-language instruction is not a security control, and local hosting does not mean no data reaches an online AI provider.

## Report privately

Do not publish credentials, customer data, active exploit details or instructions that target a real user's machine in an issue or PR.

During this private preview, report a suspected vulnerability privately to the repository owner using your existing private contact channel. Before a public release, maintainers must enable and test GitHub private vulnerability reporting and document the working contact route. Once available, use the repository's Security tab and **Report a vulnerability**. This document does not claim that button is currently enabled and makes no response-time guarantee.

Provide a minimal synthetic reproduction, affected source revision, OS/tool versions, expected boundary and observed behavior. Do not attach a real supervisor database or raw worker log. If a real credential was exposed, revoke/rotate it through its provider and preserve only sanitized evidence.

## Important boundaries

- Select the correct owner's device, runtime, store and project. A bridge connection is not permission to use another machine or tenant.
- Work runs only inside its actual approved declaration, project rules and runtime capabilities. A public issue/PR is untrusted data, not a command from the owner.
- Keep provider credentials in their approved provider/OS credential mechanism, never campaign JSON, config examples, commits or logs.
- The dashboard binds locally. Do not expose port 4318 or the local execution bridge as the public product website.
- Implementation, independent verification and release are separate responsibilities. A verifier's prose does not replace tests or grant deployment authority.
- A timed-out command can have an unknown outcome. Reconcile its recorded operation before replaying effects.

Current limitations, known findings and enabled capability state belong in [Status](docs/STATUS.md), the [runbook](docs/SUPERVISOR.md) and the relevant issues. Do not imply a formal security certification or guarantee based on these documents.

## Public contribution preparation

Before admitting outside code, verify disposable CI runners, minimum token permissions, no model/production secrets, pinned actions, external-workflow approval policy and protected integration/release paths. Never execute an untrusted PR through a privileged workflow or on the owner's persistent workstation. Dependency installation and test scripts are code execution too.

References: [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) and [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository).
