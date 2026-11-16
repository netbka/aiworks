# Using Claude with AIWorks

Claude does three different jobs around AIWorks. Knowing which one you are talking to explains what it can and cannot do.

| Role | Where it runs | What it does | What it never does |
| --- | --- | --- | --- |
| **Your assistant** | A Claude Code session you open on your PC | Sets AIWorks up, drafts plans, tells you where work stands, explains a stop | Press **Approve and start** for you, sign in for you, pay for you |
| **The worker** | Headless Claude Code runs that AIWorks starts | Builds each step in its own Git worktree; a separate run checks it | Use your personal settings, push, merge, deploy |
| **The coordinator** | A read-only Claude run behind the dashboard | Answers your messages under **Messages** and drafts plans | Register or start work, change files, post to GitHub |

You only ever talk to the first one directly. The worker and the coordinator are driven by AIWorks.

## Before you start

1. **Install Claude Code natively** on the Windows PC, under the same Windows account that will run AIWorks. AIWorks starts native executables; an npm or `.cmd` wrapper that works in your terminal may not work for it.
2. **Sign in** through Claude Code's own login screen. A Claude subscription or an API account both work. Never paste a password or token into a conversation or into `config.json`.
3. **Check it:**

   ```powershell
   Get-Command claude.exe | Select-Object Source
   claude --version
   ```

   A version number proves the program is there, not that your account can run a model. Your assistant checks the rest during setup.

Claude is the main worker and the only coordinator. Codex and Cursor are fallbacks for the worker role, but configuring only Codex gives you no coordinator.

## Talking to Claude as your assistant

Open Claude Code in any folder on the PC, in a session that can run commands, and talk in plain words. You do not need AIWorks commands or internal IDs.

**Set it up** (once):

```text
Set up AIWorks on this Windows computer from https://github.com/netbka/aiworks.
Follow docs/guides/ASSISTANT_SETUP.md. Check what is already installed,
do the setup you are allowed to do and open the dashboard.
Ask me only for sign-ins or approvals you cannot do yourself.
Do not change my project files.
```

**Plan new work:**

```text
Use AIWorks for my project in C:/Work/my-project.
I want customers to be able to reset their password.
Draft a short plan: the result, how it will be checked, what is included
and what waits. Do not edit the project. Tell me where to review it.
```

The plan appears on **Review** in the dashboard. You press **Approve and start** yourself; a press from a program is refused, so nothing starts behind your back.

**Ask where things stand:**

```text
What is AIWorks doing on my-project right now?
Is anything stuck, waiting for a usage limit or waiting for me?
```

**Understand a stop:**

```text
The password-reset step in AIWorks stopped. Find out why from the
dashboard and the run evidence, and tell me in plain words what
AIWorks will do next and whether anything is mine to do.
```

**Steer running work:** use **Send guidance** on the step in the dashboard, or ask your assistant to send it. Guidance reaches the builder or checker on its next run without interrupting the current one. Do not edit a worker's worktree by hand.

**Ask for something bigger:** a wider scope is a new plan, not an edit. Ask for a new plan the same way and approve it on **Review**.

## How AIWorks runs Claude as a worker

Each step gets a fresh, headless Claude Code session in an isolated Git worktree. To keep one run from steering the next, and to keep your private setup out of project work, that session runs **without**:

- your user, project or local Claude Code settings, permission rules or hooks;
- MCP servers or claude.ai connectors;
- saved memories, `CLAUDE.md`, the project's `.claude/agents` or skills;
- remote shells (`ssh`, `scp`, `rsync`) and scheduling or cross-session tools.

What it **does** get:

- a task packet: the goal, the acceptance criteria, the files it may change and the target project's rules;
- the project's `AGENTS.md`, named explicitly in its prompt;
- from the project's committed `.claude/settings.json`, only the subagent model and the tool-concurrency setting.

So **put the rules your project's agents must follow in `AGENTS.md`**, not in `CLAUDE.md` or personal settings: `AGENTS.md` is what the worker reads.

The builder must return a clean new commit. A **different** fresh session then checks that exact commit read-only and runs the project's tests again. Only a passed check is published as a pull request.

## Usage limits and models

- A Claude usage limit pauses only the work that uses that account. AIWorks records the reset time (30 minutes if unknown) and continues by itself, or moves the step to the next configured provider. You do not need to type "continue".
- A refused command, a sandbox refusal or a failed check is never sent to another provider to get around it.
- The plan names the Claude model for the worker, and `coordinator.model` in `config.json` names it for the coordinator. Use a model your installed Claude Code and account support.
- The dashboard's **Token usage** tab shows which model ran each step and how many tokens it reported. Your normal Claude plan limits and costs apply.

## Good habits

- Keep your project's tests runnable locally with one command, and say which in `AGENTS.md`. The checker reruns them; work it cannot check does not pass.
- Describe the result you want, not the steps. Claude plans the steps and AIWorks checks them.
- Do not put secrets or private customer data in messages or guidance; dashboard answers may be posted to GitHub.
- Running your assistant and AIWorks on the same Claude account shares one usage limit. Heavy assistant use can delay workers.

## Read more

- [Start AIWorks with your AI client](AI_ASSISTED_START.md) and [Your first task](FIRST_PROJECT.md)
- [Settings](CONFIGURATION.md): worker commands and the coordinator
- [Troubleshooting](TROUBLESHOOTING.md)
- For the exact flags and isolation rules: [the runbook, §8](../SUPERVISOR.md#8-ordered-cli-execution) and [§9](../SUPERVISOR.md#9-owner-messages-and-the-coordinator)
