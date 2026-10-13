# AIWorks

You wanted AI to help with your projects. You did not plan to spend your day managing it.

I started using AI to build my own applications. It helped me write code, investigate bugs and work through ideas. But as the work grew, I found myself doing a different job: keeping all those AI helpers moving.

One needed the next instruction. Another had stopped. A third said the task was finished, but I still had to work out what had changed and whether it solved the original problem. Switching between projects meant piecing the story back together from conversations, files and unfinished work.

I was getting help with the tasks, but I was still carrying the whole process in my head.

That is where AIWorks came from. I wanted to say what needed doing, agree on a plan and come back to a clear account of the work, instead of spending the day asking, "What happened?", "Did you check it?" and "Why did you stop?"

## What AIWorks does for you

AIWorks runs on your computer and organizes work for the AI tools you already use. It keeps track of assigned tasks, sends work to an AI helper, passes the result to a separate checking session and records what happened. When a check finds a problem, the work can go back for another attempt. Recoverable interruptions do not have to mean starting the whole conversation again.

For you, that means a place to see what is being worked on, what has been checked and what still needs your decision. You should not have to read every conversation just to find out where your project stands.

**The goal is to give you back the attention you spend coordinating AI work.** You choose what is worth doing and what a useful result looks like. AIWorks is being built to handle more of the follow-through, so you can focus on your product and the people you are building it for.

A separate check can still miss something. AIWorks makes the work and its checks visible; it does not replace your judgment about whether the result is right for your project.

## Who it is for

AIWorks is for people building and maintaining projects with AI: an independent developer, a founder working on their own application, or someone looking after several small products.

You might be comfortable asking AI to change a page or fix a bug while still being new to everything around it. The starting point here is your project and what you want to improve, not learning how to manage a collection of agents.

It is especially relevant when work takes more than one conversation, has several steps or needs another pair of eyes before you trust it.

## What it can help you work on

**Fixing something that is not working.** A sign-in flow fails or a change breaks an existing feature. The assignment can include finding the cause, making a focused repair and checking that the reported problem is addressed.

**Improving an existing application.** You want to simplify a form, add a small feature or make a screen easier to use. You describe the intended result instead of manually passing each step between AI helpers.

**Understanding and documenting a project.** Sometimes you need a report rather than a code change: explain how something works, find gaps in the setup instructions or propose an improvement plan. AIWorks can organize report tasks as well as changes to code.

**Continuing an agreed plan.** You have a list of fixes and want to move through it without reconstructing the context each time. AIWorks keeps a record of assigned work and results across the projects configured on your computer.

These are examples of work to assign, not promises that every task or tool is supported. Start with one small, useful outcome. Your AI client can help with setup and check what your installed version is ready to do.

## Start with your AI assistant

Open **Codex, Claude Code, Cursor Agent or Gemini CLI** on your computer. Use a session that can work with local files and run commands, not a chat-only window. You do not need to type the installation commands yourself.

**This is an early preview.** Setup still needs access to the project and its required services. Your assistant should check that first and tell you if anything is missing.

Copy this into your AI client:

```text
Help me set up and start AIWorks on this Windows computer:
https://github.com/netbka/aiworks

Read the README and follow docs/guides/ASSISTANT_SETUP.md.
Check what is already installed and do the setup you are allowed to do.
Open AIWorks when it is ready.

If you need me to sign in or approve access, explain just that step.
Do not change my project files yet.
```

The assistant can handle the commands and settings. You handle any sign-in or permission it cannot complete for you. [Choose your client and see the steps](docs/guides/AI_ASSISTED_START.md).

## Give it your first task

Once setup is ready, tell the same assistant which project to use and what you need:

```text
Use AIWorks for my project in C:/Work/my-project.
I want to fix the sign-in error.
Show me a short plan first. After I approve it, start the work through
AIWorks and show me where to follow its progress.
```

Replace the folder and task with your own. A bug, an existing task or a written plan is enough to begin the conversation. The assistant checks whether the installed version can work on that project; it should not promise that every folder is supported yet.

After approval, the assistant starts the work through AIWorks rather than doing the whole job in the chat. AIWorks handles the supported steps and separate checks. You can follow the result in its local dashboard. [Walk through your first task](docs/guides/FIRST_PROJECT.md).

## Just looking around?

Ask your assistant: **"Show me the AIWorks demo with sample projects. Do not connect my accounts or run real work."**

The demo lets you explore without AI-worker credentials. Its projects and progress are made up. The dashboard layout is still being improved. [More about the demo](docs/guides/INSTALLATION.md#try-the-demo-without-worker-credentials).

## A few things to know

Your usual AI account limits and costs still apply. Some setup steps require access from the project owner. A plain web chat needs a permitted connection to your computer to start anything there.

The client helping you set up AIWorks is not necessarily the tool that will do its tasks. In particular, **Gemini CLI is a setup assistant here, not a built-in AIWorks worker**. The assistant checks which workers are available. In the current setup, AIWorks prepares checked results for review; it does not automatically publish changes to your live application.

[Installation help](docs/guides/INSTALLATION.md) · [Troubleshooting](docs/guides/TROUBLESHOOTING.md) · [All guides](docs/guides/README.md)

## Prefer commands?

You can also install and run it yourself. This is optional; the AI-assisted path uses the same underlying tools.

<details>
<summary>Show the commands and technical guides</summary>

For a new source checkout you are allowed to access:

```powershell
git clone https://github.com/netbka/aiworks.git
cd aiworks
npm ci
node tests/dashboard/fixtures/review-store.mjs --port 4319
```

Open `http://127.0.0.1:4319` for the sample-data demo. This does not run a real project. Stop it with Ctrl+C.

For real work, follow [manual installation](docs/guides/MANUAL_INSTALLATION.md), [configuration](docs/guides/CONFIGURATION.md) and the [command reference](docs/guides/CLI_REFERENCE.md). The three operations are different: `serve` keeps the controller running, `message` asks for a plan, and `start` registers or resumes approved work.

From an already configured runtime, using its actual data directory and approved declaration:

```powershell
node src/supervisor/cli.mjs start campaigns/my-approved-work.json --data C:/Work/aiworks/.local/supervisor
node src/supervisor/cli.mjs status my-approved-work --data C:/Work/aiworks/.local/supervisor
```

The campaign name is a placeholder. Start the controller through the installation guide first. Registration alone is not proof a worker is running.

</details>

<details>
<summary>For contributors: project rules and architecture</summary>

## Start here

This is the engineering reading list referenced by [AGENTS.md](AGENTS.md). New users can start with the AI-assisted instructions above.

1. [Product Constitution](docs/PRODUCT_CONSTITUTION.md) - purpose and current scope
2. [Status](docs/STATUS.md) - recorded progress; issues and PRs hold live work state
3. [Agent rules](AGENTS.md) - how changes are made
4. [Decisions](docs/DECISIONS.md) - accepted decisions
5. [Delivery Supervisor](docs/SUPERVISOR.md) - execution, recovery and runtime upgrades
6. [Operations Dashboard](docs/OPERATIONS_DASHBOARD.md) - the local interface
7. [Worker Context Lifecycle](docs/WORKER_CONTEXT_LIFECYCLE.md) - packets and sessions
8. [Glossary](docs/GLOSSARY.md) - terms and IDs
9. [Workspace plan](docs/PROJECT_WORKSPACE_PLAN.md) - ongoing development

The runtime reads approved [Engineering Platform](https://github.com/netbka/engineering-platform) governance. Self-service public setup, licensing and external-contribution safeguards remain part of the [public-release checklist](docs/publication/RELEASE_CHECKLIST.md). These docs do not change repository visibility, grant a license or remove existing access requirements.

See [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md). After installing dependencies, run `npm run check`; guide examples also have `node --test tests/docs/getting-started.test.mjs`.

The showcase website waits for the finished dashboard and its acceptance, tracked in [#99](https://github.com/netbka/aiworks/issues/99). This documentation change does not build or deploy it.

</details>
