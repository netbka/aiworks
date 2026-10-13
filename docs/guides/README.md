# Using AIWorks

AIWorks coordinates approved project work; it is not another chat window or a replacement for your coding agent.

**Guide baseline:** commands and contracts inspected at AIWorks `437ef7837e28f9ade82dc911765c0c1d7da2855f`, 13 October 2026. Development continues. These are source-backed instructions, not a certification of every computer/provider combination. Read [Status](../STATUS.md), the relevant merged changes and your installed revision before enabling newer features.

## Choose your path

1. **Just exploring:** run the [synthetic local demo](INSTALLATION.md#try-the-demo-without-worker-credentials). It uses made-up projects and never sends work to a model.
2. **Installing for real work:** follow [Windows installation](INSTALLATION.md#install-for-real-project-work), then [configuration](CONFIGURATION.md) and the [first-project walkthrough](FIRST_PROJECT.md).
3. **Already installed:** use the [manual commands](FIRST_PROJECT.md#start-an-approved-campaign), or give your authorized AI assistant the [startup prompt](AI_ASSISTED_START.md#prompt-start-existing-approved-work).

A private repository still requires permission to clone it, even for the demo. Worker credentials are not needed for that demo. Real execution currently needs approved governance and registered GitHub-backed project identity. Someone without those prerequisites cannot turn the current source into a self-service installation merely by copying example files.

## The workflow in plain words

- A **project** is the thing you are working on.
- A **campaign** is an explicitly assigned program of work for that project.
- A **task** is one deliverable with acceptance criteria.
- The **supervisor** keeps execution state and runs eligible tasks.
- A **worker** does the task; another session checks the result.
- The optional **coordinator** reads your messages and proposes work. It cannot register or dispatch that work.

The current command path is: prepare and approve a declaration, get it reviewed and merged into the runtime's source, install that reviewed revision, run the controller, then register the declaration with `start`. Running `serve` alone does not assign a task. Sending `message` alone does not authorize implementation.

## What not to assume

The project-first interface, local-folder execution and automatic intake are being delivered in stages. A new module on main or an address in the dashboard is not necessarily an enabled end-to-end flow. Use the command path until the installed release explicitly supports the desired UI action. Do not invent `aiworks start-project`, an npm installer, or an MCP `campaign_start` tool.

Local Git connection support exists in the inspected code, but starting GitHub-free work remains gated. Ordinary-folder support and its reversible result-application path are tracked in [the workspace plan](../PROJECT_WORKSPACE_PLAN.md). Never run `git init` in a user's folder or create a fake GitHub identity to evade a missing feature.

Auto Release, provider routing, parallel slots and notification delivery are separate capabilities with their own enablement and evidence. Installing AIWorks does not turn them all on. Online worker tools may send authorized project context to their providers; local execution does not mean offline AI.

## Documentation map

[Installation](INSTALLATION.md) covers prerequisites, clone, demo, runtime, foreground operation and optional Windows tasks. [Configuration](CONFIGURATION.md) explains the source/runtime/state separation, provider commands, governance and coordinator setup. [First project](FIRST_PROJECT.md) walks through a report and a code task, approval, registration, control and results. [AI-assisted startup](AI_ASSISTED_START.md) supplies owner prompts and the actual CLI/bridge handoff. [Troubleshooting](TROUBLESHOOTING.md) explains refusals and evidence to collect without leaking secrets.

For maintenance, use [Contributing](../../CONTRIBUTING.md), [Security](../../SECURITY.md) and the [public-release checklist](../publication/RELEASE_CHECKLIST.md). The canonical operational details remain in [the supervisor runbook](../SUPERVISOR.md); these guides do not create new execution authority.
