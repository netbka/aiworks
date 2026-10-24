# Start using AIWorks

You do not need to learn a list of commands before trying AIWorks. Let your usual AI client help you set it up, then tell it what you want to do.

## Start here

**[Open your AI client and follow this guide](AI_ASSISTED_START.md).** It has a short setup message for Codex, Claude Code, Cursor Agent or Gemini CLI, followed by a message for your first task.

These clients need permission to work on your computer. The current preview may still need access from the project owner; your assistant checks before trying to start real work.

## What would you like to do?

Your own work is the same few steps, in the dashboard, in this order. Nothing here needs a command line or an internal task name.

| Your next step | Guide |
| --- | --- |
| Set it up or just explore the demo | [Installation](INSTALLATION.md) |
| Connect a project, plan the work and approve it | [Your first task](FIRST_PROJECT.md#connect-the-project) |
| Decide when work needs you, and see what is actually happening | [Your first task](FIRST_PROJECT.md#confirm-what-is-actually-happening) |
| Try the checked version, then accept, apply, request changes or undo | [Your first task](FIRST_PROJECT.md#review-the-result) |
| Understand something that stopped working | [Troubleshooting](TROUBLESHOOTING.md) |

You describe the result, review the plan and approve the work. Your assistant handles the setup and startup steps that it is allowed to perform, but it cannot press **Approve and start** for you. AIWorks then keeps the assigned work moving and checks the results. The dashboard's [Needs you](../OPERATIONS_DASHBOARD.md#what-the-owner-sees) list carries the decisions and result actions that are yours.

## What is checked, and what is not

- **Automated checks** (the independent check of each step, and a scripted walk through the owner screens on a disposable copy with a synthetic worker) show that the work and the screens behave as designed. They do not show that a person finds AIWorks easy to use.
- **A session with real people** who did not build AIWorks is [prepared but has not been run](../design/USABILITY_SESSION.md). Until it is, do not read any guide here as proof of ease of use.
- **Outside services** are separate and stay off until you authorize them: [alerts to your phone](../OPERATIONS_DASHBOARD.md#alerts-owner-ui-v2-wp6) need a transport you set up, and publishing your application is a [release](../OPERATIONS_DASHBOARD.md#releases-owner-ui-v2-wp9) with its own authorization. A merged or applied result is not live ([Troubleshooting](TROUBLESHOOTING.md#the-result-says-finished-but-the-product-is-not-live)).

## Prefer to do the setup yourself?

These are optional reading for someone using an AI client:

- [Manual installation](MANUAL_INSTALLATION.md) and [settings](CONFIGURATION.md) for the technical setup.
- [Running a task from the command line](CLI_REFERENCE.md), the command-line route to the same first task.
- [Instructions for the setup assistant](ASSISTANT_SETUP.md), which hold the technical checks, so the person getting started does not need to fill in internal paths or task identifiers.

For development and release work, see [the engineering reading list](../../README.md#start-here), [Contributing](../../CONTRIBUTING.md), [Security](../../SECURITY.md) and [release preparation](../publication/RELEASE_CHECKLIST.md).
