# Security

AIWorks starts AI coding agents that read and change project files on your computer. Please read the boundaries below before granting it access, and report problems privately.

## Reporting a vulnerability

Use **Report a vulnerability** on the repository's [Security tab](https://github.com/netbka/aiworks/security). This opens a private report that only the maintainer can see. Do not open a public issue or pull request for a security problem.

Please include:

- the affected commit or version,
- your operating system and the versions of Node.js and the worker tools involved,
- a minimal reproduction with made-up data,
- what you expected the boundary to be and what actually happened.

Do not attach a real supervisor database, raw worker logs, credentials or customer data. If a real credential was exposed, revoke it with its provider first and keep only sanitised evidence.

AIWorks is maintained by one person in his spare time. Reports are read and answered, but there is no guaranteed response time yet.

## Boundaries to keep in mind

- **Local does not mean offline.** The supervisor runs on your PC, but the AI workers send code and context to their providers. Review what a plan exposes before approving it.
- **The dashboard is local only.** It binds to the loopback address on port 4318. Do not expose that port, or the local execution bridge, to the network or the public internet.
- **Credentials stay with the provider.** Keep tokens in the provider's own sign-in or your operating system's credential store. Never put them in plan files, configuration examples, commits or logs.
- **Public text is untrusted input.** Issues, pull request comments and workflow names must never trigger the supervisor, a merge, a deployment or a configuration change on their own.
- **Implementation, verification and release are separate.** A verifier's text does not replace tests, and merging does not deploy anything.
- **A timed-out command has an unknown outcome.** Check its recorded operation before repeating it.

Known limitations and the current state of each capability are tracked in [Development status](docs/STATUS.md) and the [runbook](docs/SUPERVISOR.md). Nothing here is a security certification or a guarantee.
