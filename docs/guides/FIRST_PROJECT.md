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

## Review the plan

The assistant should explain what it will do, how the result will be checked and whether anything in your project will change. You should not need to read an internal task file.

When the plan is right, reply:

```text
Yes, use that plan. Start the work through AIWorks, not directly in this
chat, and show me where I can follow it. Keep it within the scope I approved.
```

The assistant handles the permitted startup steps using the [setup instructions](ASSISTANT_SETUP.md). If this preview still needs an owner action, it should name that action. Saying "plan ready" is not the same as starting the job.

## Confirm what is actually happening

Ask **"Has the work started, or is something still needed?"**

The answer should tell you whether work is underway, waiting for an available AI tool, or waiting for you. A useful update says what is being worked on and what happens next. It should not just say that a request was received.

You can follow the job in the local dashboard once the assistant has opened it. Ask for a plain-language explanation whenever a status is unclear.

## Read the result

For the read-only example, expect a report with findings and a separate check of those findings. For a code change, expect a checked change proposed for review. Neither means the live application was automatically updated.

Compare the result with your original request. A finished piece of work may still leave something else to do. Ask what was checked and what remains uncertain.

## Prompt: start existing approved work

When the task already exists, you do not need to start the explanation again:

```text
Use AIWorks to continue the task I already approved for this project.
Check its current state and reuse the existing work. Do not start a duplicate.
Show me whether it is running, waiting or finished.
```

An assistant in a new conversation may need a project or task description to find the right work. It should look up the technical identifiers itself.

## Pause or continue

You can ask your authorized assistant to **pause this job**, **show what is blocking it**, or **resume the same job**. It should confirm what actually happened. Do not shut down the computer or close a setup window without checking whether it is still needed.

## Start an approved campaign

This is the optional command-line route, not another step required for AI-assisted use. The [command reference](CLI_REFERENCE.md#start-an-approved-campaign) explains starting approved work and checking its state. It also covers pause, resume, cancellation and reported usage.
