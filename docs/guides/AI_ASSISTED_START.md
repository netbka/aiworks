# Start AIWorks with your AI client

Let the assistant handle the setup. You tell it which project you want to work on and what you need done.

## Choose your client

Use a client that can work with files and run commands **on your computer**:

| Client | Where to put the message |
| --- | --- |
| [Codex](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | A local session in your desktop or editor client, or Codex in your terminal. |
| [Claude Code](https://code.claude.com/docs/en/desktop) | A local Claude Code session with access to your chosen folder. |
| [Cursor](https://cursor.com/docs/agent/overview) | An Agent conversation in the editor, with local file and command access. |
| [Gemini CLI](https://geminicli.com/docs/tools/shell/) | Gemini running in your computer's terminal, with permission to run local commands. |

The same setup message works as an instruction for each of these clients; the actions it can take depend on its permissions and installed tools. This is not a claim that every client/version has passed an AIWorks installation test.

A normal web chat cannot start a program on your computer without an authorized connection to it. Use the local client for this guide. You do not need to turn off its safety checks.

## Copy this setup message

```text
Help me set up and start AIWorks on this Windows computer:
https://github.com/netbka/aiworks

Read the README and follow docs/guides/ASSISTANT_SETUP.md.
Check what is already installed and do the setup you are allowed to do.
Open AIWorks when it is ready.

If you need me to sign in or approve access, explain just that step.
Do not change my project files yet.
```

You do not have to supply installation paths or fill in a configuration form. The assistant should check the existing setup, suggest a location when needed and ask you only for information or actions it cannot resolve itself.

While AIWorks is in preview, access to its source and required project setup may still need to be arranged. A helpful assistant checks this early. It must not claim to have installed something it could not access.

## Ask for your first job

Once ready, give the assistant your project folder and a task:

```text
Use AIWorks for my project in C:/Work/my-project.
I want to fix the sign-in error.
Show me a short plan first. After I approve it, start the work through
AIWorks and show me where to follow its progress.
```

Replace the folder and task. After approval, the assistant performs the supported startup steps and shows whether the job is running or waiting. [Your first task](FIRST_PROJECT.md) explains what to expect and how to review the result.

## Prompt: inspect and plan a new project

To explore without making changes, say:

```text
Look at this project and help me decide what to work on first.
Prepare a short plan for AIWorks. Do not edit the project or start implementation.
```

## Prompt: start existing approved work

To return to work you already approved, say:

```text
Continue my approved AIWorks task for this project.
Check what is already running and reuse the existing job.
Tell me what is happening and whether you need anything from me.
```

In a new conversation, name the project and describe the task so the assistant can find it. You do not need to remember its internal ID.

## Will Gemini, Cursor or Codex do every task?

Not necessarily. The client helping you set up and start AIWorks is separate from the tools AIWorks uses to do the work. **Gemini CLI is a setup assistant here, not a built-in AIWorks worker.** Other worker support also depends on the installed version, account and type of task. The assistant should check what is available rather than assume your chosen client can fill every role.

Your AI service's normal usage limits and costs still apply. Sign in through its own login screen; do not paste passwords or account tokens into the conversation.

## Prefer commands or need deeper help?

You can use the [manual installation guide](MANUAL_INSTALLATION.md) and [command reference](CLI_REFERENCE.md) instead. The [assistant's technical instructions](ASSISTANT_SETUP.md) cover startup checks and the optional connection through a local command bridge. They are not required reading for your first try.
