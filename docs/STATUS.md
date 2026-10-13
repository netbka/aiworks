# Development status

This document describes source capabilities only. Installation status, connected projects, campaign progress, machine names and private operational evidence belong outside the public repository.

The code includes a persistent SQLite-backed supervisor, bounded worker sessions, independent verification, ordered provider fallback, restart recovery, a coordinator inbox and a loopback dashboard. Executable runtime code must be merged before new work starts. Campaign declarations are private local data.

Project connection, work-envelope, adaptive scheduling, routing and release designs are in `docs/design/`. A design document is not proof that its feature is implemented, enabled or deployed. Release authorization records do not enable release execution.

Use the selected installation's private status command and dashboard to verify its actual state. Never promote a repository test result into a claim about a live installation.
