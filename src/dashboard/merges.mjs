// Merged state of published campaign steps, from local git only: a step is merged when its verified commit is
// reachable from origin/<baseBranch> in the repository's configured checkout. The dashboard never calls GitHub's API;
// it refreshes the base branch with at most one `git fetch` per repository every 5 minutes, one repository at a time.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../supervisor/store.mjs';
import { DELEGATED } from './copy.mjs';

/** At most one fetch of a repository's base branches per this interval, whether the last one succeeded or failed. */
export const FETCH_INTERVAL_MS = 5 * 60_000;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const PULL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

const readConfig = (dataDir) => {
  const path = join(dataDir, 'config.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
};

/** The git command from the supervisor's config.json (`commands.git`), else `git` on PATH. */
export function configuredGitCommand(dataDir) {
  const configured = readConfig(dataDir).commands?.git;
  if (configured === undefined) return ['git'];
  if (!Array.isArray(configured) || !configured.length || !configured.every((s) => typeof s === 'string' && s.length && !/[\x00-\x1f]/.test(s))) {
    throw new Error('Supervisor commands.git must be a non-empty command array');
  }
  return configured;
}

/** Local checkouts by repository, from the supervisor's config.json `repositories.<owner/name>.path`. */
export function configuredCheckouts(dataDir) {
  const checkouts = {};
  for (const [repository, entry] of Object.entries(readConfig(dataDir).repositories ?? {})) {
    if (REPOSITORY.test(repository) && typeof entry?.path === 'string' && entry.path) checkouts[repository.toLowerCase()] = entry.path;
  }
  return checkouts;
}

const DELEGATE = /^[A-Za-z][\w .-]{0,63}$/;
const DECISION = /^#\d{1,9}$/;

/**
 * Who merges verified pull requests, from config.json `merges` (absent by default). `delegatedTo` names who the owner
 * delegated merging to and `decision` the owner decision that did it (#17). `held` maps a pull request URL to why it
 * is held from merging (a DELEGATED.held key in copy.mjs; any other reason reads as `other`). The dashboard only reads this: it never merges. Missing, unreadable or
 * malformed: null, and every verified, unmerged pull request stays the owner's to review and merge.
 */
export function configuredMergeDelegation(dataDir) {
  let merges;
  try { merges = readConfig(dataDir).merges; } catch { return null; }
  const text = (value, pattern) => typeof value === 'string' && pattern.test(value);
  if (!merges || typeof merges !== 'object' || !text(merges.delegatedTo, DELEGATE) || !text(merges.decision, DECISION)) return null;
  const held = {};
  if (merges.held && typeof merges.held === 'object' && !Array.isArray(merges.held)) {
    for (const [url, reason] of Object.entries(merges.held)) if (PULL.test(url)) held[url.toLowerCase()] = Object.hasOwn(DELEGATED.held, reason) ? reason : 'other';
  }
  return { delegatedTo: merges.delegatedTo, decision: merges.decision, held };
}

/**
 * What to check, from the supervisor store (read-only): each campaign's target repository and base branch, and the
 * verified commit of each finished step published as a pull request.
 */
export function publishedSteps(dataDir) {
  const path = join(dataDir, 'supervisor.db');
  if (!existsSync(path)) return [];
  const store = new Store(path, { readOnly: true });
  try {
    const steps = [];
    for (const { id } of store.all('SELECT id FROM campaigns ORDER BY created_at')) {
      const target = store.campaign(id).declaration.target;
      if (!REPOSITORY.test(target.repository ?? '') || !BRANCH.test(target.baseBranch ?? '')) continue;
      for (const task of store.tasks(id)) {
        if (task.state === 'done' && PULL.test(task.pr_url ?? '') && SHA.test(task.verified_sha ?? '')) {
          steps.push({ campaignId: id, taskId: task.task_id, repository: target.repository, baseBranch: target.baseBranch, sha: task.verified_sha });
        }
      }
    }
    return steps;
  } finally { store.close(); }
}

function run(command, args, options) {
  return new Promise((resolve) => {
    execFile(command[0], [...command.slice(1), ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout ?? '') }));
  });
}

export class MergeWatcher {
  /**
   * steps: returns the published steps to check (publishedSteps). checkouts: lowercased repository → local path.
   * now: the clock, replaceable in tests.
   */
  constructor({ steps, checkouts = {}, git = ['git'], now = Date.now, intervalMs = FETCH_INTERVAL_MS }) {
    this.steps = steps; this.checkouts = checkouts; this.git = git; this.now = now; this.intervalMs = intervalMs;
    // Lowercased repository → { repository, fetchedAt, attemptedAt, error, results: Map<baseBranch/sha, { merged, mergedAt, tip }> }.
    this.repositories = new Map();
    this.known = [];
    this.refreshing = null;
  }

  /**
   * Starts a refresh unless one is running; the caller does not wait for it. Repositories are handled one after
   * another. A repository's base branches are fetched only when its last fetch attempt is at least 5 minutes old.
   */
  refresh() {
    // An unexpected failure keeps the last results; the next state request tries again.
    if (!this.refreshing) this.refreshing = this.update().catch(() => {}).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async update() {
    try { this.known = this.steps(); } catch { /* the store is busy: check the steps already known */ }
    const byRepository = new Map();
    for (const step of this.known) {
      const key = step.repository.toLowerCase();
      byRepository.set(key, [...(byRepository.get(key) ?? []), step]);
    }
    for (const [key, steps] of byRepository) {
      const state = this.repositories.get(key) ?? { repository: steps[0].repository, fetchedAt: null, attemptedAt: null, error: null, results: new Map() };
      this.repositories.set(key, state);
      const path = this.checkouts[key];
      if (!path) continue;
      const branches = [...new Set(steps.map((step) => step.baseBranch))];
      if (state.attemptedAt === null || this.now() - state.attemptedAt >= this.intervalMs) {
        state.attemptedAt = this.now();
        // The git protocol, never the GitHub API. A failed fetch keeps the last results and their time.
        const fetched = await run(this.git, ['fetch', '--no-tags', '--quiet', 'origin', ...branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`)],
          { cwd: path, timeout: 60_000 });
        if (fetched.code === 0) { state.fetchedAt = state.attemptedAt; state.error = null; }
        else state.error = 'fetch-failed';
      }
      if (state.fetchedAt === null) continue;
      for (const branch of branches) {
        const tip = (await run(this.git, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: path, timeout: 10_000 })).stdout.trim();
        if (!SHA.test(tip)) continue;
        for (const step of steps.filter((item) => item.baseBranch === branch)) {
          const id = `${branch}/${step.sha}`, known = state.results.get(id);
          // A merged commit stays merged; one not merged yet is checked again whenever the base branch moves.
          if (known?.merged || known?.tip === tip) continue;
          const reachable = await run(this.git, ['merge-base', '--is-ancestor', step.sha, tip], { cwd: path, timeout: 10_000 });
          state.results.set(id, { merged: reachable.code === 0, mergedAt: reachable.code === 0 ? await this.mergedAt(path, step.sha, tip) : null, tip });
        }
      }
    }
  }

  /**
   * When the commit reached the base branch: the commit time of the first commit on the branch's first-parent line
   * that contains it (the merge commit). A commit on that line itself (a fast-forward) has no merge time: null.
   */
  async mergedAt(path, sha, tip) {
    const lines = (await run(this.git, ['rev-list', '--first-parent', '--ancestry-path', '--timestamp', '--parents', `${sha}..${tip}`], { cwd: path, timeout: 10_000 }))
      .stdout.trim().split('\n').filter(Boolean);
    const [time, , firstParent] = (lines.at(-1) ?? '').split(' ');
    return lines.length && firstParent !== sha && Number.isSafeInteger(Number(time)) ? Number(time) * 1000 : null;
  }

  /** Plain data for the owner view: per repository, whether a checkout is configured and when it was fetched; per step, the result. */
  snapshot() {
    const repositories = [...this.repositories.entries()].map(([key, state]) => ({ repository: state.repository, configured: Boolean(this.checkouts[key]),
      fetchedAt: state.fetchedAt, attemptedAt: state.attemptedAt, error: state.error }));
    const steps = {};
    for (const step of this.known) {
      const result = this.repositories.get(step.repository.toLowerCase())?.results.get(`${step.baseBranch}/${step.sha}`);
      steps[`${step.campaignId}/${step.taskId}`] = { sha: step.sha, baseBranch: step.baseBranch, merged: result ? result.merged : null, mergedAt: result?.mergedAt ?? null };
    }
    return { refreshing: Boolean(this.refreshing), repositories, steps };
  }
}
