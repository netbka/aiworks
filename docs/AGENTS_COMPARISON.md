# Which agent for what

**English** · [Русский](AGENTS_COMPARISON.ru.md)

AIWorks can work with several AI agents: Claude, Codex, AGY and Cursor. To decide which one to use for what, we ran them on one Windows computer on the same tasks. Here is what we found and what we recommend.

**In short:** on Windows, give the main work to Claude. Codex works as a backup for plans and checks, and AGY for checking websites in a browser.

## What we tested

On 16 November 2026, every agent, every model and every effort level solved the same five small tasks, each in its own clean folder:

| Task | What "passed" means |
| --- | --- |
| **Plan** from a brief with a hidden contradiction | Noticed the contradiction |
| **Fix** a broken function | Tests pass |
| **Merge a branch** that has a conflict | A correct merge commit exists |
| **Review a change** with a hidden error | Found the error |
| **Review the same change** without the error | Accepted it, invented nothing |

Scoring uses facts only: did the tests pass, is there a commit, did the verdict match. The agents had ordinary permissions, and no protection was turned off.

> **Important.** The tasks were easy: every Claude setup solved all five. So the table shows speed and cost, not the limit of quality. For hard work, treat it as a floor, not a ranking.

## Results

| Agent, model, effort | Plan | Fix | Merge | Find the error | Accept the clean one | Time for five | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude haiku, low / high | ✅ | ✅ | ✅ | ✅ | ✅ | 50–56 s | ≈ $0.02 |
| Claude sonnet, low / high | ✅ | ✅ | ✅ | ✅ | ✅ | 53–56 s | ≈ $0.30 |
| Claude opus, low / high | ✅ | ✅ | ✅ | ✅ | ✅ | 54–66 s | $0.57–0.64 |
| Codex `gpt-6.1-sol`, `gpt-6.1-terra`, low / high | ✅ | ✅ | ❌ | ✅ | ✅ | 70–135 s | 69–94k tokens |
| Codex `gpt-6-astra`, medium | ✅ | ✅ | ❌ | ✅ | ✅ | 91 s | 47k tokens |
| Codex `gpt-6-luna`, low | ❌ | ✅ | ❌ | ✅ | ✅ | 97 s | 86k tokens |
| Codex `gpt-6-luna`, high | ✅ | ✅ | ❌ | ✅ | ✅ | 148 s | 98k tokens |
| AGY, six models | ✅ | ❌ | ❌ | ❌ | ❌ | 27–44 s | not measured |

**Why there are failures, and why they are not model weakness:**

- **Codex could not merge the branch** because on Windows its safety sandbox does not allow Git commits. The cause is the environment, not the model.
- **`gpt-6-luna` at low effort** missed the contradiction in the brief. At high effort it caught it.
- **AGY failed the code tasks because of the rules, not for lack of skill.** AIWorks allowed it only website checks at the time, and in this run its commands needed a confirmation nobody could give. AGY can now be allowed into every role with a switch, and the comparison is being run again with it. The results will appear here.

## Who can do what on Windows

| Role | Claude | Codex | AGY | Cursor (Grok) |
| --- | --- | --- | --- | --- |
| Planning, coordination | ✅ | ✅ | plan only | report only, no tools |
| Code changes with commits | ✅ | ❌ on Windows | ❌ | ❌ |
| Checking a result | ✅ | ✅, but without running the project's tests | ❌ | report only |
| Merging, resolving conflicts | ✅ | ❌ | ❌ | ❌ |
| Working in a browser | ✅ | ❌ | ✅ through the AIWorks browser | ❌ |

Not tested: AGY in the AIWorks browser on a real task, and Codex on Linux or WSL.

## What we recommend

| Role | Agent and model | Why |
| --- | --- | --- |
| Coordinator and plans | Claude opus, high | A mistake in a plan costs the most. Opus costs about twice as much as sonnet, but a plan is written once |
| Build and merge | Claude sonnet, medium | Passed everything at half the price of opus |
| Check | Claude haiku, low | Found the error and accepted the clean change for about 2 cents per five tasks. For risky changes, use sonnet |
| Backup when Claude hits its limit | Codex `gpt-6-astra`, medium | Fewest tokens. Only for plans and checks, not for code on Windows |
| Website checks | AGY `gemini-3.8-flash-medium` | Claude takes over if AGY is unavailable |

Your assistant can set this up in one message:

```text
Set the AIWorks agent preferences by role from docs/AGENTS_COMPARISON.md
using the account set-preference command. Do not touch plans where an agent is named explicitly.
```

After models change, it is worth running the comparison again. Before giving unusual work to cheaper models, add harder tasks.

## Run it yourself

The comparison runs with one script. It creates throwaway folders, solves the same five tasks in them with each agent, and writes one result line per run:

```powershell
node scripts/provider-benchmark.mjs C:/Temp/agents-bench all
```

If the agent programs are not in `PATH`, set `CLAUDE_BIN`, `CODEX_BIN` and `AGY_BIN`. It uses your subscriptions or credits. AIWorks itself is not started.

## Share your results

We tested four agents on one computer with simple tasks. We would love to know how it looks for you:

- on other systems: Linux, macOS, WSL;
- with other agents and models that are not here;
- on harder tasks, yours or made up.

**[Open an issue](https://github.com/netbka/aiworks/issues/new)** and attach your results or your tasks, or just describe what you noticed. We will gladly go through them, add them to this comparison and share what we learned. If you want to connect a new agent to AIWorks, write to us too and we will talk it over.
