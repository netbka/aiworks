# Get AIWorks running

The easiest way to begin is to ask the AI client you already use to handle the setup. You do not have to copy terminal commands or edit settings by hand.

You need a Windows computer and an AI client that can work with local files and run commands. Open Codex, Claude Code, Cursor Agent or Gemini CLI. [See which kind of session to use](AI_ASSISTED_START.md#choose-your-client).

## Ask your assistant to set it up

Copy the setup message from [the AI-assisted guide](AI_ASSISTED_START.md#copy-this-setup-message). It gives the assistant the AIWorks repository and its installation instructions.

The assistant should check what is already installed, reuse a working setup and complete the permitted steps. It should only bring you in for something you need to do yourself, such as signing in or choosing a folder. Do not send it your passwords.

**The current preview is not yet a one-click public installer.** Access to the repository and project setup may still need to be arranged with the owner. The assistant should explain a missing requirement, not silently pretend that installation succeeded.

## Try the demo without worker credentials

To explore first, tell your assistant:

```text
Show me the AIWorks demo with sample projects.
Follow docs/guides/ASSISTANT_SETUP.md in the AIWorks repository.
Do not connect my accounts, edit my projects or start real AI work.
```

It can start a local preview with made-up projects. You do not need an AI-worker account for that preview, although permission to obtain the source is still required while the repository is private.

The demo is for looking around. Its progress, costs and workers are examples, not live activity. The layout is still being improved.

## Install for real project work

After setup, ask your assistant to open AIWorks and tell you whether it is ready for a real task. Seeing the dashboard alone is not enough: the tools doing the work must also be connected and available.

A useful answer is either **"Ready for your first task"** with what was checked, or **"I need you to complete this step"** with one clear action. It should not hand you a long list of unfamiliar settings.

Continue with [your first task](FIRST_PROJECT.md). Keep the computer awake while local work is running. During an initial foreground setup, the assistant should tell you which windows need to stay open.

## Manual installation (optional)

For readers who prefer the terminal, the complete [manual installation guide](MANUAL_INSTALLATION.md) covers the required software, source download, configuration, automatic Windows startup and safe updates. The [command reference](CLI_REFERENCE.md) covers starting and controlling work.

AI-assisted setup uses these same tools underneath. It saves you typing the commands; it does not remove software, account or access requirements.
