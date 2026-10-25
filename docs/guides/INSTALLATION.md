# Get AIWorks running

The easiest way to begin is to ask the AI client you already use to handle the setup. You do not have to copy terminal commands or edit settings by hand.

You need a Windows computer and an AI client that can work with local files and run commands. Open Codex, Claude Code, Cursor Agent or Gemini CLI. [See which kind of session to use](AI_ASSISTED_START.md#choose-your-client).

## Ask your assistant to set it up

Copy the setup message from [the AI-assisted guide](AI_ASSISTED_START.md#copy-this-setup-message). It gives the assistant the AIWorks repository and its installation instructions.

The assistant should check what is already installed, reuse a working setup and complete the permitted steps. It should only bring you in for something you need to do yourself, such as signing in or choosing a folder. Do not send it your passwords.

**The current preview is not yet a one-click public installer.** The source and governance starter are public. Project access, registration and work approval belong to the installation's owner. The assistant should explain a missing requirement, not silently pretend that installation succeeded.

## Try the demo without worker credentials

To explore first, tell your assistant:

```text
Show me the AIWorks demo with sample projects.
Follow docs/guides/ASSISTANT_SETUP.md in the AIWorks repository.
Do not connect my accounts, edit my projects or start real AI work.
```

It can start a local preview with made-up projects. You do not need an AI-worker account for that preview; the source and example data are public.

The demo is for looking around. Its progress, costs and workers are examples, not live activity. The layout is still being improved.

## Install for real project work

After setup, ask your assistant to open AIWorks and tell you whether it is ready for a real task. Seeing the dashboard alone is not enough: the tools doing the work must also be connected and available.

A useful answer is either **"Ready for your first task"** with what was checked, or **"I need you to complete this step"** with one clear action. It should not hand you a long list of unfamiliar settings.

Continue with [your first task](FIRST_PROJECT.md). Keep the computer awake while local work is running. During an initial foreground setup, the assistant should tell you which windows need to stay open.

## Reuse or update an existing installation

If AIWorks is already installed and healthy, your assistant should reuse it. A missing project or campaign is not a reason to create a second installation; two copies would split your work history and approvals.

An installation keeps three things apart:

- **Source**: the public AIWorks code you download.
- **Runtime**: the exact reviewed version that actually runs the work. Downloading or merging newer source does not change it.
- **Your private data**: projects, approvals, budgets, history and settings. They stay on your computer, outside the public source, and an update must not remove or replace them.

Only a version that has been independently reviewed and merged is installed. The assistant should tell you which version it proposes and why it is trusted, not pick the newest source. You do not type any version identifier.

To update, the assistant prepares it and works through [the upgrade procedure](../SUPERVISOR.md#upgrade) with you. In plain terms: it records where each unfinished project stands, pauses new work, waits for running work to finish, stops the services and confirms they stopped, installs the reviewed version, resumes the same work and compares the result with the earlier status. `npm run rebuild` does all of this in one command, and running it again after a problem continues where it stopped. If you want to pause everything yourself, use **Pause all work** on the dashboard's Home. Do not delete data or reinstall over a running installation to "fix" an update.

What only you can supply: signing in to your AI client and workers, choosing your project folder, and approving projects and work. Installing, merging and verifying are separate steps, so a prepared update is not yet a running one.

All building and checking happens on your computer. AIWorks does not use GitHub Actions or paid GitHub features for any project.

## Manual installation (optional)

For readers who prefer the terminal, the complete [manual installation guide](MANUAL_INSTALLATION.md) covers the required software, source download, configuration, automatic Windows startup and safe updates. The [command reference](CLI_REFERENCE.md) covers starting and controlling work.

AI-assisted setup uses these same tools underneath. It saves you typing the commands; it does not remove software, account or access requirements.
