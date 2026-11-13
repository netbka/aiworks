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
- Access control: either by network address (the reference service admits callers by address and lets a caller read and cancel only its own jobs), or by a credential under a documented authentication contract (see [Authentication](#authentication)). Either way a caller reads and cancels only its own jobs.
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
| `POST /v1/sources` with a git bundle (only for a service configured with `"sources": true`) | `{ sourceId, projectId, commitSha, sizeBytes, sha256 }`; see [Unpublished commits as a bundle](#unpublished-commits-as-a-bundle) |

States: `pending` (queued; `waiting.reason` may say why, such as too little free memory), `running`, then one terminal state: `passed`, `test_failure`, `environment_failure`, `cancelled` or `interrupted`.

The result holds at least `jobId`, `projectId`, `profile`, `requestedSha`, `commitSha`, `state`, `exitCode` and `commands`, a list of `{ phase, argv, exitCode }` for every step the service ran. The full gate step must be listed with its real `argv` (ending in `run check`) and exit code.

### Authentication

A service that requires a credential must document exactly how it is sent, and the operator records that contract in the service's `auth` setting. AIWorks never guesses: without `auth` it sends no credential, and a service that then answers `401` or `403` is recorded as unavailable (`the service requires authentication, and no authentication contract is configured for it`). Two schemes are known:

| `auth.scheme` | Sent on every request to the service's fixed routes |
| --- | --- |
| `bearer` | `Authorization: Bearer <value>` |
| `header` | `<auth.header>: <value>`, for a contract that names its own header, such as `X-Check-Key`. `Authorization`, `Cookie`, `Host` and the transport's own headers are not accepted. |

A scheme not in this table (for example Basic or a signed request) is not supported; such a service stays left out until the contract is added here and reviewed.

The value is never in `config.json`, `AIWORKS_CHECK_SERVICES`, a file AIWorks reads or a worker's environment. `auth.tokenRef` names it in the operator's secret store and must start with `aiworks-check-service:`, so it can never name another operator secret. The store is `token-store.mjs`: the Windows Credential Manager by default, or a credential helper command in `auth.credentialStore`.

The authentication contract never leaves the controller. `serve` exports no `auth` in `AIWORKS_CHECK_SERVICES`, and `readCheckServices` drops any `auth` it finds there: every worker inherits that variable and can rewrite it, so a service read from it can never obtain credential headers. The authorized caller builds both the services and the broker only from the controller's own `config.json`: the services from `checkServiceSettings(config)`, the broker from the same entry's `auth.credentialStore` (`tokenStoreFrom(entry.auth.credentialStore ?? { kind: "windows" })`), and passes it to `runOnService` as `broker`. The client has no default broker and never opens a store itself. That caller is not built yet. The value is resolved fresh for each offer, goes only into the request headers to the configured `https` origin (no redirect is followed, and the service certificate is verified against `caFile` as always), and never reaches `gate.log`, an error message or the returned result. An error answer is reduced to its HTTP status; its body is not read.

The service fails closed at every step:

| Situation | Recorded as |
| --- | --- |
| `auth` absent in part, an unknown scheme, a reserved header or an invalid reference | the service is left out at start (`check service left out: ...`) |
| no broker passed, the reference does not resolve, the store cannot tell, or the value is not one printable header line | `unavailable: ...`; no request is sent |
| `401` or `403` from any route | `unavailable (HTTP 401: ...)`; the job, if any, is cancelled |
| queued past `queueSeconds`, no answer within `timeoutMinutes`, a state outside the contract | the job is cancelled; no result |

None of these is a pass, a failure of the code or an approval gate. The required local checks, publication and merge go on regardless.

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
    },
    {
      "name": "lab-desktop",
      "kind": "remote-gate-http",
      "baseUrl": "https://192.0.2.20:4319",
      "caFile": "check-services/lab-desktop-ca.crt",
      "projects": {
        "example-org/sampleapp": { "projectId": "sampleapp", "profile": "windows-full" }
      },
      "auth": { "scheme": "bearer", "tokenRef": "aiworks-check-service:lab-desktop" }
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
| `auth` | Only for a service whose contract requires a credential: `{ "scheme": "bearer" \| "header", "header"?: "<name>", "tokenRef": "aiworks-check-service:<name>", "credentialStore"?: { "kind": "windows" } \| { "kind": "command", "command": [...] } }`. `header` is required with scheme `header` and not allowed with `bearer`. Without `credentialStore` the Windows Credential Manager is used. Holds a reference, never the value. See [Authentication](#authentication). |
| `enabled` | `false` leaves the service out without deleting it. |

Several services may be listed. They are tried in order, and for each repository only the services that list it are tried.

When `serve` starts it checks the entries and puts the accepted ones in its own environment as `AIWORKS_CHECK_SERVICES`. Every worker and supervisor gate it starts inherits that variable, and the gate helper reads only it. An entry with a problem is left out and named in the supervisor log (`check service left out: ...`). Without accepted entries no gate is offered. Restart `serve` after changing the settings.

## Setting one up

1. Install the service on the other computer with the project's toolchain (for example the Node.js version the project requires), and register each project with its `origin` address under a `projectId`.
2. Give the service computer a fixed address and a certificate for it, and copy the CA certificate to the AIWorks computer's data folder.
3. From the AIWorks computer, check reachability: `curl --cacert <caFile> https://<address>:<port>/health` must print `{"status":"ok"}`. If it answers `401`, obtain the service's written authentication contract (scheme and header) before going on.
4. For a service that requires a credential, store its value under a reference in the operator's secret store yourself (for the Windows Credential Manager, a generic credential named by the reference, for example `aiworks-check-service:<name>`; or through the configured credential helper's `set <ref>`, which reads the value from stdin). Never put the value in `config.json`, a command line or a file in the repository. Add `auth` with the documented scheme and that reference.
5. Add the `checkServices` entry and restart `serve`. The supervisor log names the service.
6. Not built yet: the authorized caller that reads the services and broker from `config.json` and offers commits. Once it exists, offer a commit that is already verified here and on origin through it, and read its lines: `# check service <name> accepted job ...`, then the job's states and its terminal result. Record the exact commit, job id, state, time and artifacts as operator evidence outside the repository.

## Security notes

- Only the commit identifier, the project and profile names and a short gate reference (`gate-<worktree folder name>`) are sent, plus, for a service with `auth`, its own credential to its own origin. No source and no other secret leaves the computer.
- The credential is resolved by the controller's broker, not by a worker. The services environment every worker inherits carries no `auth` at all (no scheme, reference or store), and any `auth` written into it is ignored. A worker that rewrites it can point a service at another address, but that service never receives a credential.
- The services come only from the environment `serve` gives each run, never from a shared file. Every contained worker can write to the gate slot folder. Had the list been a file there, one run could have chosen who answers the gates of other runs and of the supervisor. A worker can change only its own gate's environment, just as it could write its own `gate-exit.log`. The exact-head check (`gateHeadProblem`) and the verifier's independence cover that case.
- Keep `caFile` in a folder workers cannot write, such as the supervisor data folder.
- The service's own words (states, commit ids, errors) are reduced to plain single-line text before they reach `gate.log`. They cannot add lines the log readers take for a test summary.
- A gate helper ended by its containment (a verifier past its time bound) cannot cancel its job, so the job finishes on the service. Each new gate submits a new job.
- The service's output is copied into `gate.log` and may reach a pull request body only through the final test summary, as with a gate run here.

## Still open

- A commit that is not yet on origin can be offered only to a service configured with `"sources": true`, as a bundle (below).
- Nothing in AIWorks calls `runOnService` automatically. An authorized caller that reads services and broker from the controller's `config.json`, offers commits and records receipts is a separate change.
- Authentication schemes other than `bearer` and a named `header` are not supported.

## Unpublished commits as a bundle

A service checks a commit that is not on origin yet (a verifier gate before publication, or a merge-refresh result) without write access to anything and without AIWorks's working tree. It is off unless the operator sets `"sources": true` on that service in `config.json`; the operator decides that the service may see the project's unpublished commits. A service without it is never sent a bundle: the gate runs on this computer.

1. AIWorks (`bundleOf` in `src/supervisor/check-services.mjs`) bundles only a checkout whose `HEAD` is the exact commit, never a working tree: `git bundle create <file> HEAD --not --remotes=origin`. The bundle holds that one head and only the commits no origin branch has, at most 64 MiB.
2. `POST /v1/sources` sends it as `application/x-git-bundle` with headers `X-Project-Id` and `X-Commit-Sha` and the same authentication as every other route.
3. The service fetches origin into its own clone, runs `git bundle verify` there (every prerequisite must already be on origin), requires exactly one head equal to `X-Commit-Sha`, fetches it into a quarantine ref (`refs/aiworks-sources/<sourceId>`, never a branch, never pushed) and answers `{ sourceId, projectId, commitSha, sizeBytes, sha256 }`, with `sha256` the digest of the bytes it received. The same caller, project and commit give the same `sourceId`.
4. AIWorks compares the receipt with what it sent: commit, project, size and digest. On any difference it submits no job and moves on.
5. `POST /v1/jobs` names `sourceId`. The service accepts it only from the caller that uploaded it, for the same project and commit, and never for a custom profile. Everything else in the job, result and acceptance rules is unchanged: `requestedSha` and `commitSha` must still equal the commit.
6. The service drops a source and its quarantine ref after seven days.

A merge-refresh result is a local merge commit: its bundle carries every commit origin lacks, so both parents arrive with it.

