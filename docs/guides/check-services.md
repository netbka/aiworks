# External check services

A check service is another computer that runs a project's full gate (`npm run check`) for AIWorks. You connect it as a plug-in in `config.json`. When a service is listed for a repository, every full gate of the gate helper on that repository is offered to it first. If the service is busy, down or cannot run that commit, the gate runs on this computer exactly as it does without a service. Nothing waits on a service and no service is required.

Code: `src/supervisor/check-services.mjs` (settings, the service client and result acceptance) and `src/supervisor/gate.mjs` (`offload`, called by the gate helper's `run`).

## What happens on a gate

1. A worker, or the supervisor's own refresh or base gate, starts the gate helper (`node src/supervisor/gate.mjs start`). The helper records the commit and whether the checkout is clean in `gate-head.log`, as before.
2. The helper offers the gate to a service only when all of these hold:
   - the command is the default full gate, `npm run check` (an explicit command always runs here);
   - the checkout is clean at a known commit;
   - it is not a gate inside a gate (the suite's own gate tests);
   - the supervisor published at least one service for the checkout's `origin` repository (see [Settings](#settings-in-configjson));
   - a branch of `origin`, as this checkout last fetched it, contains the commit. A service fetches from `origin` and accepts no uploaded source, so a commit that exists only on this computer runs here.
3. The services listed for the repository are tried in order. For each one the helper:
   - reads `GET /health` and skips the service unless it answers `{"status":"ok"}`;
   - submits the exact commit with `POST /v1/jobs`;
   - polls `GET /v1/jobs/<id>` every 10 seconds;
   - cancels its own job and moves on when the job is still queued after `queueSeconds` (the service is busy), when the run takes longer than `timeoutMinutes`, when the service answers a state the contract does not name twice in a row, or when it stops answering.

   All services together get one time budget: the largest `timeoutMinutes` of those listed for the repository, at most 75 minutes. A gate that then runs on this computer after a long wait may not fit a verifier's 120-minute bound (`executor.verifierTimeoutMinutes`); that verification is then started again. Keep `timeoutMinutes` near the service's real run time, or raise the verifier bound.
4. A finished job counts only as described in [Which answers count](#which-answers-count). When one counts, `gate.log` gets one line naming the service and job, then the service's own `stdout.log`, and `gate-exit.log` gets `0` (passed) or `1` (test failure). The gate holds no slot on this computer meanwhile, and the test result cache records nothing from it, because it ran on another computer and toolchain.
5. When no service gave an answer that counts, the gate takes a slot here and runs as before. Every decision appears in `gate.log` as a line starting with `# check service`.

The controller reads the run as it reads any gate run (`readGateRun`, `gateHeadProblem`): the recorded commit must be the verified head on a clean checkout.

### Which gates can go to a service today

Only commits already on `origin` can go to a service. A verifier checks a new head before anything is pushed: the supervisor publishes only verified work, and workers never push. So a verifier's gate of a new commit runs on this computer, as do merge-refresh gates, which test a local merge commit. What goes to a service today:

- base checks of a base branch that is on `origin`;
- re-checks of a head that was already pushed, such as a new verification after a moved base or a retry.

Verifier gates of new commits can go to a service only once the service accepts the source from AIWorks, not just from `origin`. A proposed addition to the contract is `POST /v1/sources` taking a git bundle of the commit. AIWorks does not have it yet.

## Which answers count

`acceptRemoteResult` decides. A result counts only when:

- it names the job, project and profile that were submitted, and `requestedSha` is the exact commit;
- `commitSha` (the commit the service actually checked out) is that commit, or empty for a run that never reached checkout;
- the state is terminal.

Then:

| Service state | In AIWorks |
| --- | --- |
| `passed` with `exitCode` 0, `commitSha` the exact commit, a step whose `phase` ends in `-check`, whose `argv` ends in `run check` and whose `exitCode` is 0, and a non-empty `stdout.log` (for a project tested by `scripts/run-tests.mjs`, one with its `# all test files` summary) | gate passed (exit 0) |
| `test_failure` | gate failed (exit 1) |
| `environment_failure`, `cancelled`, `interrupted` | does not count: next service, else this computer |
| a pass missing any of the conditions above | does not count: next service, else this computer |

A service never makes a failing commit pass by being down: no answer means the gate runs here.

## Requirements for a service

A service of kind `remote-gate-http` must provide the following.

### Network and TLS

- HTTPS on a fixed address that the AIWorks computer can reach, normally on the local network. Reserve the address (for example a DHCP reservation), because the certificate names it.
- A certificate for that address, signed by a CA certificate that you copy to the AIWorks computer (`caFile`). AIWorks trusts only that certificate for the service, never the system store, and never disables verification.
- Access control without secrets in AIWorks's configuration: the reference service admits callers by their network address and lets a caller read and cancel only its own jobs. A service that needs a token is not supported yet, because `config.json` holds no secret values.
- Requests and answers are small JSON, except `stdout.log`. AIWorks reads at most 64 MiB of any answer. It ends a request that has not completed within 30 seconds in total (5 minutes for `stdout.log`).

### Routes

| Route | Answer |
| --- | --- |
| `GET /health` | `{"status":"ok"}` when it accepts jobs |
| `POST /v1/jobs` with `{ idempotencyKey, projectId, commitSha, profile, timeoutSeconds, aiworksTaskId }` | `{ jobId, state, spec }`, where `jobId` is a UUID and `spec` repeats `commitSha`, `projectId` and `profile`. The same `idempotencyKey` with the same body returns the same job. AIWorks sends `aiworksTaskId` as `gate-<worktree folder>`: letters, digits, dot, dash and underscore only. |
| `GET /v1/jobs/<jobId>` | `{ jobId, state, waiting? }` |
| `GET /v1/jobs/<jobId>/result` | the result described below, once the state is terminal |
| `GET /v1/jobs/<jobId>/artifacts/stdout.log` | the gate's output as text |
| `POST /v1/jobs/<jobId>/cancel` with `{}` | cancels a pending or running job of this caller |

States: `pending` (queued; `waiting.reason` may say why, such as too little free memory), `running`, then one terminal state: `passed`, `test_failure`, `environment_failure`, `cancelled` or `interrupted`.

The result holds at least `jobId`, `projectId`, `profile`, `requestedSha`, `commitSha`, `state`, `exitCode` and `commands`, a list of `{ phase, argv, exitCode }` for every step the service ran. The full gate step must be listed with its real `argv` (ending in `run check`) and exit code.

### Running the gate

- Fetch the project from its `origin` itself and check out the exact requested commit in a fresh workspace, then report the commit it actually checked out as `commitSha`. Never run another commit, a branch tip or a working tree with changes.
- Prepare dependencies from the lock file (for npm projects `npm ci`), then run `npm run check` in that workspace.
- Report `test_failure` only when the gate itself failed. Report a fetch, checkout, install, disk, memory or tooling problem as `environment_failure`, so AIWorks runs the gate itself instead of recording a code failure.
- Keep jobs `pending` while the service has no room. Run one full gate at a time unless the computer clearly has room for more: an overloaded computer turns timing tests into false failures.
- Hold no credentials for publishing. A service only reads `origin`.

## Settings in config.json

Add `checkServices` to the supervisor's `config.json` in its data folder (installation data, never committed). Example with fictional values:

```json
{
  "checkServices": [
    {
      "name": "lab-laptop",
      "kind": "remote-gate-http",
      "baseUrl": "https://192.0.2.10:4319",
      "caFile": "check-services/lab-laptop-ca.crt",
      "projects": {
        "example-org/sampleapp": { "projectId": "sampleapp", "profile": "full" }
      },
      "queueSeconds": 120,
      "timeoutMinutes": 60
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Your name for the service, shown in `gate.log` and the supervisor log. Letters, digits, dot, dash, underscore. |
| `kind` | The plug-in. Known: `remote-gate-http`. |
| `baseUrl` | The service's `https://` origin only: no path, query or credentials. |
| `caFile` | The CA certificate that signed the service certificate. A relative path is read from the supervisor data folder. |
| `projects` | Which repositories may go to this service: `"<owner>/<repository>"` as in the checkout's `origin`, mapped to the service's own `projectId` and `profile`. Other repositories never go to it. |
| `queueSeconds` | How long a job may stay queued before AIWorks cancels it and runs the gate itself. 10 to 3600, default 120. |
| `timeoutMinutes` | The longest run AIWorks waits for. 5 to 75, default 60. The service is told to stop a minute earlier (`timeoutSeconds`). A run that ends without an answer that counts is then run here too, inside the verifier bound (`executor.verifierTimeoutMinutes`, default 120). |
| `enabled` | `false` leaves the service out without deleting it. |

Several services may be listed. They are tried in order, and for each repository only the services that list it are tried.

When `serve` starts it checks the entries and puts the accepted ones in its own environment as `AIWORKS_CHECK_SERVICES`. Every worker and supervisor gate it starts inherits that variable, and the gate helper reads only it. An entry with a problem is left out and named in the supervisor log (`check service left out: ...`). Without accepted entries no gate is offered. Restart `serve` after changing the settings.

## Setting one up

1. Install the service on the other computer with the project's toolchain (for example the Node.js version the project requires), and register each project with its `origin` address under a `projectId`.
2. Give the service computer a fixed address and a certificate for it, and copy the CA certificate to the AIWorks computer's data folder.
3. From the AIWorks computer, check reachability: `curl --cacert <caFile> https://<address>:<port>/health` must print `{"status":"ok"}`.
4. Add the `checkServices` entry and restart `serve`. The supervisor log names the service.
5. Push a commit that is already verified here and watch the next gate: `gate.log` starts with `# check service <name> accepted job ...`.

## Security notes

- Only the commit identifier, the project and profile names and a short gate reference (`gate-<worktree folder name>`) are sent. No source, secrets or credentials leave the computer.
- The services come only from the environment `serve` gives each run, never from a shared file. Every contained worker can write to the gate slot folder. Had the list been a file there, one run could have chosen who answers the gates of other runs and of the supervisor. A worker can change only its own gate's environment, just as it could write its own `gate-exit.log`. The exact-head check (`gateHeadProblem`) and the verifier's independence cover that case.
- Keep `caFile` in a folder workers cannot write, such as the supervisor data folder.
- The service's own words (states, commit ids, errors) are reduced to plain single-line text before they reach `gate.log`. They cannot add lines the log readers take for a test summary.
- A gate helper ended by its containment (a verifier past its time bound) cannot cancel its job, so the job finishes on the service. Each new gate submits a new job.
- The service's output is copied into `gate.log` and may reach a pull request body only through the final test summary, as with a gate run here.

## Still open

- A verifier gate of a commit that is not yet on origin, and a merge-refresh gate, cannot be offered. The service fetches only from origin. `POST /v1/sources` (a git bundle of the commit) is a proposed addition to the contract and is not built.
- A service that needs a token is not supported. Configuration holds no secret values.
