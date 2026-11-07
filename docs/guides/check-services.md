# Additional check services

A check service can run an additional check of an exact published commit on another computer. Its result is information; it does not replace the required local gate. The managed gate helper always runs its local command inside the exclusive host slot and proves that command's complete process tree has stopped before publishing its exit.

Code: src/supervisor/check-services.mjs retains the settings, client and exact-revision result validation. The gate helper no longer offers jobs automatically, accepts a remote result as its local exit, or cancels service jobs. Existing configuration and historical receipts remain intact. Separate authorized callers can use the client for additional checks, with its bounded queue/run waits and exact-source validation.

Callers must submit only an exact published commit that the configured origin makes available. The client checks service health, polls its own job and bounds its waits; it accepts no uploaded source. A missing, busy, unreachable or unsuitable service is no barrier to the local checks, publication or merge. Do not duplicate an already submitted service job merely because a local gate starts.

## Which answers count

`acceptRemoteResult` validates an additional result. It counts as a service result only when:

- it names the job, project and profile that were submitted, and `requestedSha` is the exact commit;
- `commitSha` (the commit the service actually checked out) is that commit, or empty for a run that never reached checkout;
- the state is terminal.

Then:

| Service state | Additional result |
| --- | --- |
| `passed` with `exitCode` 0, `commitSha` the exact commit, a step whose `phase` ends in `-check`, whose `argv` ends in `run check` and whose `exitCode` is 0, and a non-empty `stdout.log` (for a project tested by `scripts/run-tests.mjs`, one with its `# all test files` summary) | service check passed (exit 0), with the local gate still required |
| `test_failure` | service check failed (exit 1) |
| `environment_failure`, `cancelled`, `interrupted` | no accepted additional result; the separate client may try its next configured service |
| a pass missing any of the conditions above | no accepted additional result; the separate client may try its next configured service |

A service result never makes a failing local gate pass. The local contained gate remains mandatory even when the additional result passed.

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
