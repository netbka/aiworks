# Provider benchmark and model choices

Observed on a Windows workstation on 16 November 2026 with `scripts/provider-benchmark.mjs`. It ran five small tasks in disposable folders for every provider, model and effort below: plan a feature from a brief that contains a contradiction, fix a failing function, merge a branch with a conflict, review a diff with a planted off-by-one error, and review the same diff with the error removed. Scoring is objective: tests pass, a merge commit with two parents exists, the verdict matches. Permissions stayed scoped (edits plus git, npm and node for Claude, `workspace-write` for Codex, accept-edits for AGY); nothing bypassed a sandbox.

The tasks were easy. Every Claude configuration passed all five, so the run shows cost and speed, not a ceiling of quality. Treat the results as a floor, not as a ranking for hard work.

## Results

| Provider, model, effort | plan | implement | merge | verify bug | verify clean | time for five | cost |
|---|---|---|---|---|---|---|---|
| Claude haiku, low / high | pass | pass | pass | pass | pass | 50-56 s | about $0.02 |
| Claude sonnet, low / high | pass | pass | pass | pass | pass | 53-56 s | about $0.30 |
| Claude opus, low / high | pass | pass | pass | pass | pass | 54-66 s | $0.57-0.64 |
| Codex `gpt-6.1-sol`, `gpt-6.1-terra`, low / high | pass | pass | fail | pass | pass | 70-135 s | 69-94 k tokens |
| Codex `gpt-6-astra`, medium | pass | pass | fail | pass | pass | 91 s | 47 k tokens |
| Codex `gpt-6-luna`, low | fail | pass | fail | pass | pass | 97 s | 86 k tokens |
| Codex `gpt-6-luna`, high | pass | pass | fail | pass | pass | 148 s | 98 k tokens |
| AGY, six models | pass | fail | fail | fail | fail | 27-44 s | not measured |

The failures are expected, not model weakness. Codex could not create the merge commit: on Windows its sandbox cannot commit through Git (`roleUnavailableReason` in `src/supervisor/adapters/executors.mjs`). `gpt-6-luna` at low effort missed the contradiction in the brief. AGY is restricted by design to web acceptance, with file, command and write tools denied, so every code task failed for that reason.

## Who can do what

| Scenario | Claude | Codex | AGY | Cursor (Grok) |
|---|---|---|---|---|
| Planning, coordination | yes | yes | plan only | report-only, no tools |
| Implementation (commits) | yes | not on Windows | no | no (only the code broker for an attested repository) |
| Verification | yes | yes, without running the repository's tests on Windows | no | report-only |
| Merge, conflict resolution | yes | no | no | no |
| Browser | yes (headless Chrome in the test) | no | yes, only through the browser AIWorks provides (`chrome-devtools-mcp`); the plain CLI has none and answered `NO_BROWSER` | no |

The AGY browser path and Codex on Linux or WSL were not exercised here.

## Recommended models

- Coordinator and planning: Claude opus, high. A wrong plan costs the most, and opus was about twice sonnet's price in this run.
- Implementation and merge: Claude sonnet, medium. It passed everything at half the cost of opus.
- Verification: Claude haiku, low. It found the planted error and accepted the clean change for about two cents per five tasks. Raise it to sonnet for risky changes.
- Fallback when Claude waits on a limit: Codex `gpt-6-astra`, medium, for planning and verification (fewest tokens). Not for implementation or merge on Windows.
- Web acceptance: AGY `gemini-3.8-flash-medium` first, Claude as the existing fallback.
- Cursor: unchanged.

These are role preferences for `account set-preference`; a campaign that pins its own executor and model keeps them. Rerun the script after a model change and compare, and add harder tasks before relying on the cheaper choices for work that is not routine.
