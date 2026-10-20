// Hash addresses of the owner workspace (docs/design/OWNER_WORKSPACE.md §3.2). Pure functions with no DOM access, so
// the page and Node tests import the same module. The address is the state: reload, Back, Forward and bookmarks work.

/** The global destinations, in navigation order. Home leads (OWNER_UI_V2 section 2, WP1). */
export const GLOBAL = ['home', 'projects', 'needs', 'settings'];
/** The four project tabs, in order; they fit at 320px. */
export const TABS = ['now', 'work', 'results', 'cost'];

/** Today's single-word addresses, redirected once to where their content lives now (§9). */
export const LEGACY = Object.freeze({ overview: '#/projects', roadmap: '#/settings/diagnostics', work: '#/settings/diagnostics',
  agents: '#/projects', messages: '#/settings/messages', activity: '#/settings/diagnostics' });

const PROJECTS = Object.freeze({ screen: 'projects' });
const HOME = Object.freeze({ screen: 'home' });
const decode = (part) => { try { return decodeURIComponent(part); } catch { return null; } };
// A project is a GitHub `owner/repo`, or the opaque ID a project connection assigns (#7). Never a filesystem path.
const projectId = (value) => typeof value === 'string' && /^(?:[\w.-]+\/[\w.-]+|[\w-]{1,64})$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value) ? value : null;
// Work, step and plan names: the identifiers the supervisor and declarations use.
const name = (value) => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value) && !/^\.{1,2}$/.test(value) ? value : null;

/** The route an address names, or null when it names nothing. */
function parse(hash) {
  if (typeof hash !== 'string') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('/')) return null;
  const parts = raw.slice(1).split('/').map(decode);
  if (parts.some((part) => part === null || part === '')) return null;
  const [first, ...rest] = parts;
  if (first === 'home') return rest.length ? null : HOME;
  if (first === 'projects') return !rest.length ? PROJECTS : rest.length === 1 && rest[0] === 'add' ? { screen: 'add-project' } : null;
  if (first === 'needs') return rest.length ? null : { screen: 'needs' };
  // The local work list (UI20): the list, one item by its number, and the imported issues' preview.
  if (first === 'worklist') {
    if (!rest.length) return { screen: 'worklist' };
    if (rest.length !== 1) return null;
    if (rest[0] === 'import') return { screen: 'worklist-import' };
    return /^[1-9]\d{0,8}$/.test(rest[0]) ? { screen: 'worklist-item', number: Number(rest[0]) } : null;
  }
  if (first === 'settings') {
    if (!rest.length) return { screen: 'settings' };
    return rest.length === 1 && ['messages', 'diagnostics', 'accounts', 'version', 'instructions', 'connections', 'alerts', 'usage'].includes(rest[0]) ? { screen: 'settings', section: rest[0] } : null;
  }
  if (first !== 'p' || !rest.length) return null;
  const project = projectId(rest[0]), tail = rest.slice(1);
  if (!project) return null;
  if (!tail.length) return { screen: 'project', project, tab: 'now' };
  if (tail.length === 1 && ['work', 'results', 'cost'].includes(tail[0])) return { screen: 'project', project, tab: tail[0] };
  if (tail.length === 1 && tail[0] === 'start') return { screen: 'start', project };
  if (tail.length === 1 && tail[0] === 'settings') return { screen: 'project-settings', project };
  if (tail.length === 1 && tail[0] === 'knowledge') return { screen: 'knowledge', project };
  if (tail.length === 1 && tail[0] === 'plan') return { screen: 'plan', project };
  if (tail.length === 2 && tail[0] === 'review' && name(tail[1])) return { screen: 'review', project, plan: tail[1] };
  if (tail.length === 3 && tail[0] === 'step' && name(tail[1]) && name(tail[2])) return { screen: 'step', project, work: tail[1], step: tail[2] };
  return null;
}

/** The address of a route; the inverse of parsing for every valid route. */
export function formatRoute(route) {
  const p = (value) => encodeURIComponent(value);
  switch (route?.screen) {
    case 'home': return '#/home';
    case 'needs': return '#/needs';
    case 'worklist': return '#/worklist';
    case 'worklist-import': return '#/worklist/import';
    case 'worklist-item': return `#/worklist/${route.number}`;
    case 'add-project': return '#/projects/add';
    case 'settings': return route.section ? `#/settings/${route.section}` : '#/settings';
    case 'project': return `#/p/${p(route.project)}${route.tab && route.tab !== 'now' ? `/${route.tab}` : ''}`;
    case 'start': return `#/p/${p(route.project)}/start`;
    case 'project-settings': return `#/p/${p(route.project)}/settings`;
    case 'knowledge': return `#/p/${p(route.project)}/knowledge`;
    case 'plan': return `#/p/${p(route.project)}/plan`;
    case 'review': return `#/p/${p(route.project)}/review/${p(route.plan)}`;
    case 'step': return `#/p/${p(route.project)}/step/${p(route.work)}/${p(route.step)}`;
    default: return '#/projects';
  }
}

/**
 * What the page shows for an address. `replace` is true when the address in the bar should be rewritten once, with
 * history.replaceState: an empty hash or an unknown address (both open Home), a legacy view name (its view's new home),
 * or a valid address written in a non-canonical form.
 */
export function resolveRoute(hash) {
  const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (Object.hasOwn(LEGACY, raw)) {
    const address = LEGACY[raw];
    return { route: parse(address), address, replace: true, legacy: raw };
  }
  const route = parse(raw ? `#${raw}` : '') ?? HOME, address = formatRoute(route);
  return { route, address, replace: `#${raw}` !== address, legacy: null };
}

/** The route's global destination, for aria-current in the global bar. Project screens belong to Projects; the work list to Needs me. */
export const globalOf = (route) => ['home', 'needs', 'settings'].includes(route.screen) ? route.screen : route.screen.startsWith('worklist') ? 'needs' : 'projects';
/** The project tab a route belongs to, or null. Step belongs to Work; Start work, Plan, Review, Project settings and Knowledge to Now. */
export const tabOf = (route) => route.screen === 'project' ? route.tab : route.screen === 'step' ? 'work' : ['start', 'plan', 'review', 'project-settings', 'knowledge'].includes(route.screen) ? 'now' : null;
