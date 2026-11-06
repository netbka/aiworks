// The Home screen's five blocks (docs/design/HOME_V2.md): what needs the owner, what is in progress, what was decided
// for them, what landed, and which projects are quiet. It only arranges the Home data it is given. Every word of that
// data goes in as a text child, never as markup and never into an attribute that is read as an address. Nothing here
// reads the page, so a test can build it with a stand-in for `el`.

const TONES = { done: 'merged', now: 'building', asks: 'you', todo: 'todo', dropped: 'waiting' };
const PILLS = { 'Asks you': 'attention', Building: 'in_progress', Checking: 'review', Queued: 'pending', Paused: 'pending' };
const LANDED_SHOWN = 5;

// While AIWorks is still finding out whether a result merged, the headline never claims calm: the count stays the
// owner's own actions, and the words say that something is still being checked.
export const heroWords = (count, checking = 0) => count === 0
  ? checking > 0 ? 'Nothing needs you, but a result is still being checked.' : 'Nothing needs you.'
  : count === 1 ? 'One question for you.' : `${count} things need you.`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The one grey line under the headline: what is moving and what landed. */
export function summaryLine(goals, landed, checking = 0, count = 0) {
  const moving = goals.filter((goal) => goal.state !== 'Paused');
  const projects = [...new Set(moving.map((goal) => goal.project).filter(Boolean))];
  const where = projects.length === 1 ? ` in ${projects[0]}` : projects.length > 1 ? ` across ${plural(projects.length, 'project')}` : '';
  return [moving.length ? `${plural(moving.length, 'goal')} ${moving.length === 1 ? 'is' : 'are'} moving${where}.` : 'Nothing is moving right now.',
    landed.total ? `${plural(landed.total, 'change')} landed since yesterday.` : null,
    checking > 0 && count > 0 ? 'A result is also still being checked.' : null].filter(Boolean).join(' ');
}

/**
 * @param data   the Home data (goals, landed, needs, quiet, spentToday) plus `decided` ({ question, chosen, address }),
 *               `address(project)` for a project's page, `confirmation` text or null, `needCards` (finished nodes)
 * @param h      { el, timeAgo }
 */
export function homeBlocks(data, h) {
  const { el, timeAgo } = h;
  const goals = data.goals ?? [], landed = data.landed ?? { total: 0, entries: [] }, quiet = data.quiet ?? [];
  const count = data.needs?.count ?? 0, checking = data.checking ?? 0, own = data.ownProblems ?? { count: 0, address: null };
  const out = [];

  // AIWorks's own problems are one grey line linking to Settings, never part of the owner's count (HOME_V2.md).
  const ownWords = own.count > 0 ? `AIWorks has ${plural(own.count, 'problem')} of its own.` : null;
  out.push(el('section', { class: 'home-hero', 'aria-labelledby': 'home-title' },
    el('h1', { id: 'home-title', tabindex: '-1' }, heroWords(count, checking)),
    el('p', { class: 'home-summary' }, summaryLine(goals, landed, checking, count)),
    ownWords ? el('p', { class: 'home-summary home-own' }, own.address ? el('a', { href: own.address }, ownWords) : ownWords) : null,
    data.confirmation ? el('p', { class: 'home-confirm', role: 'status' }, data.confirmation) : null));

  if (count > 0 && data.needCards?.length) out.push(el('section', { class: 'home-block home-needs', 'aria-label': 'Needs you' },
    el('ul', { class: 'home-cards' }, ...data.needCards.map((card) => el('li', {}, card)))));

  if (goals.length) {
    const spent = data.spentToday?.usd;
    out.push(el('section', { class: 'home-block', 'aria-labelledby': 'home-progress' },
      el('div', { class: 'home-head' }, el('h2', { id: 'home-progress' }, 'In progress'),
        typeof spent === 'number' ? el('span', { class: 'home-note' }, `$${spent.toFixed(2)} spent on these today`) : null),
      el('ul', { class: 'home-goals' }, ...goals.map((goal) => {
        const shown = goal.total - goal.dropped, to = data.address?.(goal.project) ?? null;
        return el('li', { class: 'home-goal' },
          el('div', { class: 'home-goal-top' },
            to ? el('a', { class: 'home-goal-title', href: to }, goal.title) : el('span', { class: 'home-goal-title' }, goal.title),
            el('span', { class: `badge ${PILLS[goal.state] ?? 'pending'}` }, goal.state)),
          goal.now ? el('div', { class: 'home-now' }, goal.now) : null,
          shown > 0 ? el('div', { class: 'home-progress-row' },
            el('div', { class: 'step-strip', role: 'img', 'aria-label': `${goal.done} of ${shown} steps done` },
              ...goal.segments.filter((segment) => segment !== 'dropped').map((segment) => el('span', { class: `step-seg ${TONES[segment] ?? 'todo'}` }))),
            el('span', { class: 'home-note' }, `${goal.done} of ${shown} done`)) : null);
      }))));
  }

  const decided = data.decided ?? [];
  if (decided.length) out.push(el('section', { class: 'home-block', 'aria-labelledby': 'home-decided' },
    el('h2', { id: 'home-decided' }, 'Decided for you'),
    el('ul', { class: 'home-lines' }, ...decided.map((d) => el('li', {}, el('span', {}, d.question, ' ', el('strong', {}, d.chosen)),
      d.address ? el('a', { href: d.address }, 'Change') : null)))));

  if (landed.entries.length) {
    const rows = data.showAll ? landed.entries : landed.entries.slice(0, LANDED_SHOWN);
    out.push(el('section', { class: 'home-block', 'aria-labelledby': 'home-landed' },
      el('div', { class: 'home-head' }, el('h2', { id: 'home-landed' }, 'Landed since yesterday'),
        landed.total > LANDED_SHOWN && data.onShowAll ? el('button', { class: 'home-all', type: 'button', onclick: data.onShowAll }, data.showAll ? 'Fewer' : `All ${landed.total}`) : null),
      el('ul', { class: 'home-lines home-landed' }, ...rows.map((entry) => el('li', {},
        el('span', { class: 'home-check', 'aria-hidden': 'true' }, '✓'),
        el('span', { class: 'home-landed-title' }, entry.title),
        el('span', { class: 'home-note' }, [entry.project, timeAgo(entry.at)].filter(Boolean).join(' · ')))))));
  }

  if (quiet.length) out.push(el('section', { class: 'home-block', 'aria-labelledby': 'home-quiet' },
    el('h2', { id: 'home-quiet' }, 'Quiet'),
    el('ul', { class: 'home-quiet' }, ...quiet.map((project) => {
      const to = data.address?.(project.name) ?? null, words = `${project.name} · ${project.state.toLowerCase()}`;
      return el('li', {}, to ? el('a', { href: to }, words) : words);
    }))));
  return out;
}
