# Glossary

- **Campaign:** an explicitly authorized set of tasks, declared in private local JSON and registered in the installation store.
- **Task:** one dependency-aware deliverable inside a campaign.
- **Supervisor:** the durable controller that assigns work, records state, verifies results and publishes authorized deliverables.
- **Coordinator:** a fresh read-only planning session that answers operator messages; it never registers work or changes project authority.
- **Operator:** the person who supplies project access and campaign authority.
- **Governance directory:** a configured read-only source of project contracts, policy IDs and authority pointers.
- **Runtime checkout:** detached executable source pinned to a reviewed merged revision.
- **Worktree:** a separate Git checkout assigned to one implementation or verification session.
- **Task packet:** bounded, revision-pinned instructions whose digest binds identity, role, authority, constraints and acceptance.
- **Lease generation:** the fencing number that distinguishes a current controller from a stale writer.
- **Verification:** a separate fresh review of the exact revision or report digest.
- **Publication:** posting the verified report or opening a pull request; it is separate from merge, deployment and acceptance.
- **Blocker:** a proved condition that stops dependent work until evidence or authorized action resolves it.
- **Scope digest:** an identifier for immutable campaign scope; it must not change on an identical resume.

Private project identifiers, campaign IDs and machine names are installation data, not public glossary entries.
