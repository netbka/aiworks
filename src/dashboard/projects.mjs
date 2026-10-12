// Projects from today's data (docs/design/OWNER_WORKSPACE.md slice S2, build slice UI3): one row per GitHub repository
// that has work on this computer or is listed in the supervisor's config.json, each with one state and one next action.
// There is no project record yet: the list joins the campaigns' target repositories with the configured ones, grouped
// case-insensitively. Local Git and plain folders need project connection (#7). The state is built from the owner view,
// so a project never reads calmer than its Needs me items; no campaign id is used at the primary level.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;
const TERMINAL = ['finished', 'cancelled'];
/** Display order: projects that need the owner, then those with work running, then the rest by last activity. */
const RANK = { 'needs-you': 0, running: 1 };

/**
 * The repositories the supervisor's config.json lists for this computer (`repositories.<owner/name>`). Names only:
 * the configured checkout path is never read out or served.
 */
export function configuredRepositories(dataDir) {
  let config;
  try { config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')); } catch { return []; }
  const listed = config?.repositories;
  return listed && typeof listed === 'object' && !Array.isArray(listed) ? Object.keys(listed).filter((name) => REPOSITORY.test(name)) : [];
}

const label = (task) => task?.outcome ?? task?.title ?? 'a step';
const lastActivity = (campaigns) => Math.max(0, ...campaigns.map((c) => Date.parse(c.lastProgressAt ?? '') || c.registeredAt || 0)) || null;

/** The one next action for a project whose Needs me items are `items`: the item's own link when there is one item. */
function needsAction(items) {
  const [item] = items, url = items.length === 1 ? item.link?.url ?? '' : '';
  const pr = PR_URL.exec(url);
  if (pr) return { label: `Review pull request #${pr[1]}`, url };
  if (ISSUE_URL.test(url)) return { label: 'Open the step issue', url };
  return { label: items.length === 1 ? 'See what needs you' : `See all ${items.length} in Needs me`, route: { screen: 'needs' } };
}

/** One state, in plain words, for a project with active (not finished or cancelled) work and nothing for the owner. */
function activeState(active) {
  const agents = active.flatMap((c) => c.agents.map((agent) => ({ agent, task: c.tasks.find((task) => task.id === agent.taskId) })));
  const building = agents.find(({ agent }) => agent.role === 'Implementer'), checking = agents.find(({ agent }) => agent.role === 'Verifier');
  if (building) return { key: 'running', text: `Working on: ${label(building.task)}.` };
  if (checking) return { key: 'running', text: `Checking: ${label(checking.task)}.` };
  const going = active.filter((c) => c.control !== 'paused');
  if (!going.length) return { key: 'paused', text: 'Paused. No new step starts.' };
  if (going.some((c) => c.waitingReason === 'provider-availability')) return { key: 'running', text: 'Waiting for an AI worker to be free. Work continues by itself.' };
  if (going.every((c) => c.control === 'cancel-requested')) return { key: 'running', text: 'Cancelling: waiting for running workers to stop.' };
  return { key: 'running', text: 'No AI worker is busy on this project right now.' };
}

/**
 * The Projects screen. `supervisor` is supervisorSnapshot, `owner` is ownerView of it, `repositories` the configured
 * repository names (configuredRepositories). Each project: `id` (the repository, its address on the page), a short
 * `name`, `kind`, one `state` ({ key, text }) and one `action` ({ label, url } for a GitHub link or { label, route }
 * for a screen of this page). Repository owner and the number of pieces of work are details.
 */
export function projectsView(supervisor, owner, { repositories = [] } = {}) {
  if (!supervisor?.available) return { available: false, projects: [] };
  const groups = new Map();
  const group = (repository) => {
    const key = repository.toLowerCase();
    if (!groups.has(key)) groups.set(key, { repository, configured: false, campaigns: [] });
    return groups.get(key);
  };
  // The configured spelling names the project when there is one; otherwise the first campaign's.
  for (const repository of repositories) if (REPOSITORY.test(repository)) group(repository).configured = true;
  for (const c of supervisor.campaigns) if (REPOSITORY.test(c.repository ?? '')) group(c.repository).campaigns.push(c);
  const items = owner?.items ?? [];
  const projects = [...groups.values()].map(({ repository, configured, campaigns }) => {
    const route = (tab) => ({ screen: 'project', project: repository, tab });
    const mine = items.filter((item) => item.repository?.toLowerCase() === repository.toLowerCase());
    const active = campaigns.filter((c) => !TERMINAL.includes(c.control));
    let state, action;
    if (mine.length) {
      state = { key: 'needs-you', text: mine.length === 1 ? 'One thing needs you.' : `${mine.length} things need you.` };
      action = needsAction(mine);
    } else if (active.length) {
      state = activeState(active);
      action = { label: 'Open current work', route: route('work') };
    } else if (campaigns.length) {
      // The most recent finished or cancelled piece of work, in the owner view's own words.
      const latest = [...campaigns].sort((a, b) => lastActivity([b]) - lastActivity([a]))[0], view = owner?.campaigns?.[latest.id];
      const text = latest.control === 'cancelled' ? view?.outcome ?? 'Cancelled' : view?.finished ?? 'All steps are finished';
      state = { key: latest.control === 'cancelled' ? 'cancelled' : 'finished', text: /[.!?]$/.test(text) ? text : `${text}.` };
      action = { label: 'See results', route: route('results') };
    } else {
      state = { key: 'no-work', text: 'No work yet.' };
      action = { label: 'Open project', route: route('now') };
    }
    return { id: repository, name: repository.split('/')[1], repository, kind: 'GitHub', state, action, lastActivityAt: lastActivity(campaigns),
      details: { owner: repository.split('/')[0], work: campaigns.length, configured, needsYou: mine.length } };
  });
  // Two repositories with the same name under different owners keep their owner in the name.
  const shared = projects.filter((project) => projects.some((other) => other !== project && other.name.toLowerCase() === project.name.toLowerCase()));
  for (const project of shared) project.name = project.repository;
  projects.sort((a, b) => (RANK[a.state.key] ?? 2) - (RANK[b.state.key] ?? 2) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
  return { available: true, projects };
}
