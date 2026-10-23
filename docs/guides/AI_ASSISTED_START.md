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

Once ready, name your project and what you want. Agree the scope once; AIWorks does the execution and routine investigation.

```text
Use AIWorks for my project in C:/Work/my-project.
I want to fix the sign-in error.
Draft a short plan for me: the result, how it will be checked, what is
included and what waits. Do not edit the project yet.
Then tell me where to review it.
```

Replace the folder and task. The plan appears on **Review** in the dashboard, where you press **Approve and start** yourself: an assistant cannot press it for you, and a press from a program AIWorks started is refused. Nothing begins before that. Afterwards the page says AIWorks is waiting to pick the work up, which is not the same as work having begun. Ask the assistant to check, or open **Needs you** and the project's Overview, to see whether work is underway, waiting for an available AI tool or waiting for you.

You do not have to inspect pull requests, task files or logs. When something needs you, it appears in the dashboard as a decision in business terms, or as a checked result with **Accept result** or **Request changes**; answer or request changes there, in place, and the answer stays inside the plan you approved. New or wider scope is not an edit: ask for a new plan through the same plan route and approve it. [Your first task](FIRST_PROJECT.md) explains what to expect and how to review the result.

## Demo, working installation and delivery are different

- A **demo** runs a synthetic review fixture on a disposable local address. Its projects, costs and worker states are made up. It shows the screens only: no worker is active and nothing is delivered.
- A **working installation** has your project connected and an approved plan. Only then can workers be active, and only the dashboard (not the setup message) tells you whether they are.
- **Delivery** is a checked result you have reviewed. Accepting or applying it is not releasing it: publishing your application stays a separate step with its own authorization.

None of this requires a new installation, external notifications or a release. If you already have a working installation, the assistant should reuse it.

## Prompt: inspect and plan a new project

To explore without making changes, say:

```text
Look at this project and help me decide what to work on first.
Prepare a short plan for AIWorks. Do not edit the project or start implementation.
```

The plan is a proposal until you approve it on **Review**.

## Prompt: start existing approved work

To return to work you already approved, say:

```text
Continue my approved AIWorks task for this project.
Check what is already running and reuse the existing job.
Tell me whether it is working, waiting for a tool, waiting for me or
finished, and whether you need anything from me.
```

In a new conversation, name the project and describe the task so the assistant can find it. You do not need to remember its internal ID.

## Will Gemini, Cursor or Codex do every task?

Not necessarily. The client helping you set up and start AIWorks is separate from the tools AIWorks uses to do the work. **Gemini CLI is a setup assistant here, not a built-in AIWorks worker.** Other worker support also depends on the installed version, account and type of task. The assistant should check what is available rather than assume your chosen client can fill every role.

Your AI service's normal usage limits and costs still apply. Sign in through its own login screen; do not paste passwords or account tokens into the conversation.

## Prefer commands or need deeper help?

You can use the [manual installation guide](MANUAL_INSTALLATION.md) and [command reference](CLI_REFERENCE.md) instead. The [assistant's technical instructions](ASSISTANT_SETUP.md) cover startup checks and the optional connection through a local command bridge. They are not required reading for your first try.
