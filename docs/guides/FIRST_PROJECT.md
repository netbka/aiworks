# Give AIWorks your first task

Start with one small, useful job. You do not need to know how AIWorks names its internal tasks or where it stores them.

Once [setup is ready](INSTALLATION.md), tell the same AI assistant **where your project is** and **what you want done**. A folder, an existing task or a short description is enough to start the conversation.

## Describe the result

For a first try, a read-only task is easy to review:

```text
Use AIWorks for my project in C:/Work/my-project.
Read the project's installation instructions and tell me what a new
user would find confusing. Suggest improvements, but do not edit files.
Show me a short plan before starting.
```

Replace the folder with yours. You can also describe a bug or ask the assistant to continue an existing plan. It should check whether the installed version supports work on that project. Being able to select a folder does not mean every local-folder workflow is ready yet.

## Connect the project

Connecting only reads the folder. In the dashboard, **Add project** (when your installation has switched it on) checks a GitHub checkout, a local Git repository or a plain folder and connects it. A project without GitHub starts no work until you confirm its rules once on its Now screen; until then the screen says so and **Needs you** names the project. If Add project is off, ask your assistant what the installation supports. See [Add project](../OPERATIONS_DASHBOARD.md#add-project-built-off-by-default).

## Review and approve the plan

Plan and do (also switched on per installation) drafts a plan from your description. Open it on **Review**: it shows the result you asked for, how each part is checked, what is included and what waits for later, an estimate (or *No estimate*), what the work may change and the limits. You can **Edit plan** before approving; a wider scope or bigger budget is a new plan, not an edit.

The decision is yours. Press **Approve and start** to register exactly the plan on the screen; you do not need an assistant or a command line, and a plan that changed or went stale since you opened it is refused rather than started. The assistant can still draft, explain and follow the work using the [setup instructions](ASSISTANT_SETUP.md), but it cannot press Approve for you: a press from a program AIWorks itself started is refused. After approval the page says AIWorks is waiting to pick the work up; it does not mean work has begun.

## Confirm what is actually happening

Ask **"Has the work started, or is something still needed?"** or open the dashboard's **Needs you** and the project's Overview.

The answer should say whether work is underway, waiting for an available AI tool, or waiting for you. If a step needs your input it appears as a **decision** with its options, usually with a short question in business terms. Answer it there; the answer stays inside the plan you approved. A step that stopped without a decision says it will not retry by itself. You never need to inspect pull requests, task files or logs: AIWorks investigates those itself.

## Review the result

A step that passes the independent check appears on **Review** with its criteria and evidence.

- **Try this version** may show the checked version before you decide. It serves only the exact checked commit, and only static pages (such as an `index.html`) unless the operator has configured a preview script for that project. Otherwise it says why no preview is available: the step delivers a report, it has not passed the check, you already asked for changes, or the version needs its own server or a build that AIWorks does not start. Missing preview is not a failure of the work.
- **Project without GitHub:** nothing in your folder changes until you press **Apply**. AIWorks first rereads the folder; if a file the result touches changed since AIWorks copied it, Apply is refused and nothing is written. It keeps a backup, and **Undo apply** puts the folder back unless a file has changed since. No pull request exists for such a project.
- **GitHub project:** you may **Accept result** or **Request changes**. If your project is set to accept automatically, a checked result merges under the merge gate without waiting for you; if you set it to accept results yourself, it waits in **Needs you**.

Applying or merging is not deploying. Nothing here publishes your application: release stays a separate step that needs its own authorization. Compare the result with your request, and ask what was checked and what remains uncertain.

## Prompt: start existing approved work

When the task already exists, you do not need to start the explanation again:

```text
Use AIWorks to continue the task I already approved for this project.
Check its current state and reuse the existing work. Do not start a duplicate.
Show me whether it is running, waiting or finished.
```

An assistant in a new conversation may need a project or task description to find the right work. It should look up the technical identifiers itself.

## Pause or continue

In the dashboard or through your authorized assistant, you can **pause this job**, **show what is blocking it**, or **resume the same job**. It should confirm what actually happened. Do not shut down the computer or close a setup window without checking whether it is still needed.

## Start an approved campaign

This is the optional command-line route, not another step required for AI-assisted use. The [command reference](CLI_REFERENCE.md#start-an-approved-campaign) explains starting approved work and checking its state. It also covers pause, resume, cancellation and reported usage.
