# Local governance starter

This is redistributable product configuration, not an operator's inventory or an authorization record. It contains no registered projects. Run `npm run setup:local` from the source checkout to create a new, ignored `.local/governance` directory. Existing governance is never replaced.

The operator owns this local directory; AIWorks reads it. Set `governanceRoot` in `.local/supervisor/config.json` to its absolute path. No separate repository, account, service or private download is required. Existing approved governance remains supported without migration.

To register a project the owner has authorized, copy `project.example` to `registry/projects/<id>.json` inside the generated local directory, fill in its actual identity and authority files, and verify the local Git remote. An authority path is relative to that project's repository and must point to an existing non-secret rules file. The runtime validates the contract and rejects unsafe authority paths. Do not register the example identity unchanged. A registry entry permits admission checks; it does not approve a work plan, merge or deployment.

Keep real project records, plans, approvals, policies, roadmaps and machine settings only in `.local/`. Never edit the distributable starter to describe your installation. The default policy preserves explicit scope, independent verification, credential boundaries and separate release authority. No exception or release grant is provided by this starter.
