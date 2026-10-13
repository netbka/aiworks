# Development status

This document describes source capabilities only. Installation status, connected projects, campaign progress, machine names and private operational evidence belong outside the public repository.

The code includes a persistent SQLite-backed supervisor, bounded worker sessions, independent verification, ordered provider fallback, restart recovery, a coordinator inbox and a loopback dashboard. Executable runtime code must be merged before new work starts. Campaign declarations are private local data.

Coordinator plans and replies stay in the local dashboard. Requests retain their selected repository and run separately. Older pending coordinator replies are retained locally instead of published to GitHub. Registered campaign publication uses its declared target repository.

Code for sharing work between several logins of one provider through CAAM (choosing a login per run, keeping a usage limit with its login, restart recovery and a rollback switch) is in the source, switched off. No running supervisor uses it yet: launching a worker inside its login's own home folder is still to come, and turning it on waits for the owner's pilot. See [SUPERVISOR.md section 13](SUPERVISOR.md#13-caam-account-profiles-built-not-enabled).

Project connection, work-envelope, adaptive scheduling, routing and release designs are in `docs/design/`. A design document is not proof that its feature is implemented, enabled or deployed. Release authorization records do not enable release execution.

Use the selected installation's private status command and dashboard to verify its actual state. Never promote a repository test result into a claim about a live installation.
