# Design: Docker work and verification on a second computer

Status: proposal (example-org/aiworks#39). Nothing here is built. Host names and paths are fictional: the supervisor computer is `desk-a`, the second computer `bench-b`, paths look like `E:/example`.

## 1. Problem

Every worker, verifier and merge-refresh gate runs on the supervisor computer. Projects whose checks start Docker stacks are capped at two stacks there (`docker.slots`, [the Docker gate](../../src/supervisor/docker-gate.mjs)) after a host crash from TCP port exhaustion on 2026-10-31. The owner has a second Windows computer that is often idle but sometimes off, asleep or busy with the owner's own work. The question is how to use it without changing the rules that make AIWorks trustworthy:

- **R1 Exact head.** A verifier judges the exact head SHA and echoes it; acceptance needs a clean checkout at that SHA ([SUPERVISOR section 4](../SUPERVISOR.md)).
- **R2 Containment.** Every process tree runs under the runner's Job Object and settles before a result is accepted.
- **R3 No secrets in configuration.** Nothing secret in `config.json`, declarations, the repository or the packet.
- **R4 Never wait for the owner** ([AW-017](../DECISIONS.md#aw-017---aiworks-decides-and-finishes-without-the-owner)). A computer that is off or slow costs time, never a stall, and never an owner prompt.
- **R5 Local only.** No GitHub Actions (free or self-hosted), no paid GitHub features, no paid services. Everything runs on the owner's two computers.

## 2. What exists today (observed)

- The Docker gate is a Docker API proxy on a named pipe. `serve` sets `DOCKER_HOST` to it for workers and refresh gates. It forwards to the operator's own `DOCKER_HOST` when one was set before `serve` started (`cli.mjs`, `directHost`), so a different engine behind the gate needs no change in the gate's forwarding idea; only its `engine` must accept a non-pipe address (today a pipe or socket path used with `http.request({ socketPath })`).
- The gate counts slots from the engine on every decision, bounds any wait (`maxWaitMs`) and falls back to direct Docker if the gate is down.
- The gate helper (`gate.mjs`) runs `npm run check` as a separate process with its own exit-code file; `wait` reports passed, failed, running or died.
- Host pressure sampling (`host.mjs`) already measures ports, memory, disk and Docker answer time for the one local host.
- Write domains (`writes`) and `domainHolders` already decide which tasks may run together inside one installation; the merge gate serializes merges per repository under one lease.

## 3. The three options

### 3.1 Option A: a remote Docker engine, workers stay local

`bench-b` runs Docker Desktop or the engine in WSL2; `desk-a` talks to it through a Docker context (`ssh://worker@bench-b` or a TLS endpoint). The supervisor, workers, verifiers and gates all run on `desk-a`; only container starts move.

**AIWorks changes.** Small: allow the gate's `engine` to be a remote address (an ssh stream or a local tunnel port) with a connect timeout; count slots against the remote engine and give it its own `slots`; add one health probe ("answers within N seconds") to the pressure sample. No change to the runner or packet.

**Tests that expect services on localhost.** This is the hard part and the main weakness. A test library publishes a container port and then connects to `localhost:<port>` (or `host.docker.internal`). With a remote engine that port opens on `bench-b`, not on `desk-a`. Ways to cope, none complete:
1. Testcontainers-style libraries honour `TESTCONTAINERS_HOST_OVERRIDE`; set it to `bench-b`. Needs the published ports reachable through the LAN and firewall on `bench-b`; works for libraries that read the host from the library, not for hard-coded `localhost` in test configuration.
2. An SSH tunnel per published port (`ssh -L`) opened by a watcher that follows the engine's events. Ports are dynamic, so this is a moving target and a new source of ephemeral ports on `desk-a`, the very resource that crashed it.
3. Run the test process itself next to the engine, which is Option B.

Bind mounts and Compose volumes name paths on the engine host, not `desk-a`, so any stack that mounts the worktree breaks or silently mounts the wrong (or no) directory on `bench-b`. Images built from a local context stream the whole context over the link.

**Containment.** Containers on `bench-b` are outside the Job Object of the runner on `desk-a`. When the runner kills a worker tree, the remote containers keep running. Cleanup needs a label on every container (`aiworks.run=<runId>`) and a reaper that removes by label after the run settles, plus a reaper on `bench-b` for orphans after a crash. Without it R2 is weakened.

**Secrets.** SSH key in the agent or Windows OpenSSH agent of the owner's account, never in configuration; only the context name is configured. TLS client keys would be files and are therefore worse. Any image pull credential stays in the engine's own credential store on `bench-b`.

**Off or slow.** Probe with a short timeout before every container start. Down: use the local engine under the local gate (`slots: 2`). Slow: the gate's `maxWaitMs` already bounds waits; add a remote latency threshold that switches to local. A engine that disappears mid-run fails that Docker call; the step is retried under the normal retry rules.

**Exact head and evidence.** Unchanged for source (worktree and verifier are local). The evidence gap: container logs and the engine's identity live remotely; the verifier sees only what the tests print. Nothing about the head is proved by the remote engine.

**Windows.** Docker Desktop on `bench-b` must be running while nobody is signed in, which Docker Desktop does not do reliably; the engine in WSL2 under a scheduled task is more robust. OpenSSH server setup, firewall rules and the `npipe` versus `ssh://` difference all matter. Sleep and updates make the engine vanish.

**Cost.** None beyond electricity. Network traffic stays on the LAN.

**Verdict.** Cheapest to start but leaks the most problems (localhost, mounts, orphan containers, new port pressure on `desk-a`). Not recommended as the main design.

### 3.2 Option B: a remote verifier host

`desk-a` stays the only supervisor. For a verification (and a merge-refresh gate) it sends `bench-b` an exact head and gets back a result and evidence. The code, tests and Docker stacks of that gate all run on `bench-b` against its own local Docker, so localhost works unchanged.

**Flow.**
1. `desk-a` writes a *remote job request*: run id, repository id, head SHA, tree SHA, the gate command from the declaration (already a data array), timeout, and a one-time nonce. No secrets, no paths of `desk-a`.
2. The head reaches `bench-b` as a Git object, not as a working copy: `bench-b` holds a bare mirror and fetches the SHA from `desk-a` over `git://`-free SSH (`git fetch ssh://worker@bench-b`-style push from `desk-a` into the mirror under `refs/aiworks/<runId>`). It then creates a detached worktree at that SHA and checks `HEAD == SHA` and `tree == tree SHA` before running anything.
3. A small agent on `bench-b` (`remote-agent.mjs`, started by a scheduled task, listening only on loopback and reached through an SSH forward, or run as a command through SSH per job) runs the gate through the same `gate.mjs` helper in a Job Object, on a private Docker gate pipe with its own slot limit, and writes `gate.log`, `gate-exit.log` and a manifest.
4. `desk-a` pulls back the manifest (head, tree, exit code, start/end times, tally lines, sha256 of each log) and the logs, and stores them as the run's evidence exactly where a local gate's evidence goes (`readGateRun`).

**AIWorks changes.** Moderate. A `remote` executor-like placement for the *gate* step only (the verifier's model session stays local; it is the shell command that moves); a job table in the store keyed by run id for idempotence; the agent; a health/capacity probe; fallback logic in one place. The verifier prompt changes: "the full gate ran on a remote host; read the manifest, do not rerun" with local fallback instructions.

**Containment.** The agent runs each job in a Job Object and removes the job's containers by label. Job directories live in a dedicated root on `bench-b` (`E:/remote-jobs/<runId>`), garbage-collected after evidence is pulled. The worktree is detached and read-only for the verifier; the gate writes only to its own job directory. `bench-b` receives only the SHA being tested, which the owner already has on both machines for Git; no installation data is sent.

**Secrets.** The SSH key lives in the owner's OpenSSH agent or Windows credential store on `desk-a`, restricted on `bench-b` with a forced command (`command="…remote-agent run-job",no-port-forwarding,no-pty`) so the key can start a job and nothing else. Nothing goes into `config.json` but the host alias (`bench-b`), and the forced command accepts only the typed request. Project secrets a gate needs (if any) are the project's own `.env` placed once on `bench-b` by the owner, not transmitted by AIWorks; AIWorks never reads them. Gates that need credentials not present on `bench-b` are not eligible and run locally.

**Off or slow.** Before offering a job, `desk-a` probes the agent (timeout 5 s) and reads its reported load and free slots. Not ready: run locally exactly as today, no log line louder than an information note. Accepted but silent: a heartbeat file is pulled every 30 s; no heartbeat for 3 minutes, or no progress past `remote.maxMinutes`, releases the job (`abandon` on `bench-b` by label and Job Object) and the same gate starts locally. Fallback runs are bounded to one local rerun per verification, and a gate that failed *on the remote host with an exit code* is a failure, not a reason to rerun (so a remote cannot be used to shop for a pass). The supervisor never waits for the owner to switch the computer on; an off computer is just "not ready".

**Exact head and evidence.** The strongest of the three. The head is identified by SHA and tree before the gate starts and again in the manifest; the manifest ties exit code and log hashes to that SHA; `desk-a` accepts the evidence only if the manifest SHA equals the verified target, the nonce matches, and the worktree on `bench-b` was clean after the run (`git status --porcelain` empty, recorded in the manifest). The gate's own tally lines are copied verbatim from the log. A manifest is evidence of what ran on `bench-b`, not a signature; the trust boundary is the owner's own computer reached over SSH, which the design states plainly. `desk-a` may additionally re-verify cheap properties locally (head, tree, log hashes).

**Windows.** OpenSSH Server on `bench-b`; a scheduled task at startup running the agent as the owner's account (not SYSTEM) so Docker, Git credentials and Job Objects behave; hidden launch everywhere (`CreateNoWindow`, `UseShellExecute=false`); long paths enabled; `core.autocrlf` and `core.longpaths` aligned with `desk-a`; Windows Update restarts make the host vanish, which the fallback covers; the owner's own sessions on `bench-b` are protected by below-normal priority and the same pressure thresholds.

**Cost.** None. LAN only; no Actions, no hosted runner.

**Verdict.** Best fit: it moves exactly the expensive, Docker-heavy, exact-head step, and leaves orchestration, secrets, budgets and merge on one computer.

### 3.3 Option C: a second independent AIWorks installation

`bench-b` runs its own supervisor, store, campaigns and accounts, against the same GitHub repositories.

**AIWorks changes.** Few in code, many in operation: two stores and two journals with no shared state, so every cross-installation guarantee (write domains, ownership, budgets, one merge lease) must come from outside. Needed code: a branch namespace per installation (`campaign/<installation>-<campaignId>/<taskId>`), claim markers on the remote (a ref such as `refs/aiworks/claims/<installation>/<taskId>`), and a merge protocol.

**Collisions.** Write domains: `domainHolders` reads only the local store. Two installations would need a shared claim registry; the only shared place is GitHub, so claims are refs or issue labels, with races (two pushes of a claim at once; the first push wins, the second fast-forward fails). Merges: the local merge gate serializes under one lease; across installations, GitHub merges themselves serialize but the refresh gate ("the base this PR leaves") assumes only one merge path. Two installations merging at once make both refresh results stale at once; the loser is sent back as an integration repair, which costs a worker and a verifier run each time. A static partition (installation A owns repositories 1 to 3, B owns 4 to 5, never the same repository) avoids all of it and is the only safe form.

**Containment.** Fully independent, each as today.

**Secrets.** Each installation needs its own provider login, GitHub login and token: a second set of credentials on a second computer. That is the owner's own sign-in, which AIWorks never performs; it is a manual, owner-side setup and a second place for secrets to leak from.

**Off or slow.** Naturally independent: when `bench-b` is off, its repositories simply do not progress, which is a stall unless the repositories can be taken over by `desk-a`. A takeover needs the claim protocol and an expiring lease across two machines with unsynchronized clocks. Without it the rule "never wait" is violated for the partition.

**Exact head and evidence.** Each installation verifies its own heads exactly. Cross-installation review (one verifies the other's heads) is not in the model and would need to be built; without it, independence is only that of the one installation.

**Windows.** The full installation procedure ([LOCAL_OPERATION](LOCAL_OPERATION.md), deploy scripts, services, dashboard) on a second computer, each with a data directory, ports and a separate dashboard. Upgrades must be done twice and kept in step.

**Cost.** No new service, but double the AI usage accounts and double the upgrade and monitoring work; budgets are per installation and cannot be summed.

**Verdict.** Highest capacity gain and the most new coordination risk; it multiplies the owner's chores. Defer; it becomes interesting only with a static repository partition and a stable need for more parallel workers, which this issue is not.

## 4. Comparison

| Point | A remote engine | B remote verifier host | C second installation |
| --- | --- | --- | --- |
| Moves | container starts | the gate/verify shell step | everything |
| Localhost services | broken or patched per project | work unchanged | work unchanged |
| Bind mounts and build context | break | work (local to `bench-b`) | work |
| AIWorks change | small | moderate (agent, job table, fallback) | small code, large operation |
| Containment (R2) | weak: remote containers outlive Job Object | Job Object plus label reaper on `bench-b` | as today |
| Secrets (R3) | SSH or TLS key on `desk-a` | forced-command SSH key; project env placed by owner on `bench-b` | second full credential set |
| Off or slow (R4) | probe, then local | probe, heartbeat, then local; bounded | partition stalls without takeover |
| Exact head and evidence | head unchanged; evidence thin | head and tree checked on both sides; manifest with hashes | per installation |
| New port pressure on `desk-a` | yes (tunnels) | no (relief) | no |
| Cost (R5) | none | none | none, plus owner upkeep |

## 5. Recommendation

**Option B, as a remote gate host.** It keeps the supervisor, packet, budgets, secret filtering and merge gate on `desk-a` and moves only the command that is expensive and Docker-heavy. It preserves exact-head verification by construction (SHA and tree checked before and after, manifest bound to the target), contains the work in a Job Object with a label reaper, keeps secrets out of configuration (an SSH key behind a forced command; only a host alias is configured) and satisfies the never-wait rule with a probe, a heartbeat, a bound and a one-time local fallback.

Option A is a possible later accelerator for single projects whose tests honour a host override, but not a platform. Option C stays deferred.

### 5.1 Rules the design keeps

- **Exact head.** The remote gate runs only a SHA that `desk-a` named; it verifies `HEAD` and tree before running and records both and a clean tree afterwards. Evidence whose SHA, tree or nonce differ is discarded and the gate runs locally. The verifier's own session still runs on `desk-a`, read-only, and still echoes the target SHA and report hash.
- **Independent verification.** A remote gate is a measurement tool of the verifier, not a verifier. The fresh verifier session reads the manifest and the log; the controller reads the same files through `readGateRun` as for a local gate. A remote result never substitutes for the verifier's review.
- **Containment.** Job Object per job on `bench-b`; every container labelled with the run id; reaper after the job and at agent start; the job directory is the only writable root.
- **Secrets.** No secret in `config.json`, the packet, the request or the manifest. Configuration holds an alias, a slot count and bounds. Output is passed through the existing secret filter before it is stored.
- **Never wait for the owner.** All waits are bounded and end in a local run. No state of the remote host is an owner prompt; the dashboard shows "second computer: not ready" as information.
- **No cost.** No Actions, no hosted runner, no paid service; the second computer is the owner's.

## 6. Build plan

Each slice is a day or less and ends with a gate that passes on its own. Configuration lives under a new optional `remote` key, off by default, so nothing changes until slice 6.

1. **Request and manifest schemas (R1).** Define the job request and result manifest (run id, repository id, SHA, tree SHA, nonce, command array, timeout, exit code, clean flag, log hashes, tally lines) and validators in `src/supervisor/remote-job.mjs`. *Acceptance:* a manifest with the wrong SHA, tree, nonce, missing clean flag or a hash mismatch is refused; a matching one is accepted; schema rejects any field named like a secret and any absolute path of the sender. Unit tests only.
2. **Remote agent that runs a job locally.** `remote-agent.mjs run-job <request>` fetches the SHA from a mirror (or, in the test, a local bare repository), checks `HEAD`/tree, creates a detached worktree under its job root, runs the command through `gate.mjs` on a private gate pipe, and writes the manifest, with a label reaper. *Acceptance:* on one computer with a synthetic repository, a passing and a failing command give the right manifest; a killed agent leaves no container with the run label after the next start; a tampered worktree is reported unclean.
3. **Transport over SSH with a forced command.** `desk-a` pushes the SHA to the mirror under `refs/aiworks/<runId>` and invokes the agent through `ssh`, copying the manifest and logs back. The forced command accepts only typed requests. *Acceptance:* with a loopback SSH test host (or a mocked transport in tests), an exact head round trip works; an extra argument, a second command or a different key is refused; no key path appears in configuration or logs.
4. **Probe, heartbeat and bounded fallback.** Probe before dispatch (5 s), heartbeat pulls, `remote.maxMinutes`, abandon with reaper, single local rerun. *Acceptance:* tests with a transport that is off, hangs after accept, goes silent mid-run or returns a failing exit code: off/hang/silent run locally once and finish; a remote failure with an exit code is not rerun; no path waits on the owner; the verifier's total bound is unchanged.
5. **Controller integration for verification.** The verifier's gate and the merge-refresh gate use the remote host when `remote.enabled` and a slot is free; journal rows `remote-gate-started`, `-passed`, `-failed`, `-fell-back`; the manifest becomes the gate evidence read by `readGateRun`; restart resumes the same job by run id (idempotent, no second job). *Acceptance:* a crash between request and result resumes the same remote job once; evidence with a different SHA is not accepted as a pass; a gate that fell back is recorded as local; the verifier prompt tells it which form ran.
6. **Windows setup guide and slot limits.** Document and script, as a printed checklist for the owner, the OpenSSH server, the scheduled task for the agent, the mirror location, the private Docker gate slots on `bench-b` and the below-normal priority; add remote health to the pressure sample and the dashboard as information. *Acceptance:* `node src/supervisor/cli.mjs remote-check` (read-only) reports ready/not ready with reasons for a fictional host without changing it; the documentation follows the public-scope check; a dry run on the real second computer is reported by the owner's own run, not required by this slice's tests.
7. **Measured switch-on.** Enable on one repository at `slots: 1`, compare gate time, fallback count and host pressure on `desk-a` over a week of campaigns, then raise slots. *Acceptance:* no `desk-a` pressure episode caused by Docker, zero accepted evidence with a mismatched SHA, every fallback bounded; leave it off if any is violated.

## 7. Open points

- Which gates need project secrets: those stay local until the owner places the project's own environment on `bench-b` (a manual step AIWorks does not read).
- Docker Desktop versus engine in WSL2 on `bench-b`, decided in slice 6 from what the owner has installed.
- Whether a worker's own container work (not the verifier's gate) should later use the same placement; out of scope here.
