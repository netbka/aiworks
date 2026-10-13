// Hash addresses of the owner workspace (docs/design/OWNER_WORKSPACE.md §3.2, slice S1): every address parses and
// formats back to itself, today's addresses are redirected once, and anything else opens Projects. Pure functions only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRoute, globalOf, GLOBAL, LEGACY, resolveRoute, tabOf, TABS } from '../../src/dashboard/public/router.mjs';

// Every address of the §3.2 table, with the route it names.
const ADDRESSES = [
  ['#/projects', { screen: 'projects' }],
  ['#/projects/add', { screen: 'add-project' }],
  ['#/needs', { screen: 'needs' }],
  ['#/settings', { screen: 'settings' }],
  ['#/settings/messages', { screen: 'settings', section: 'messages' }],
  ['#/settings/diagnostics', { screen: 'settings', section: 'diagnostics' }],
  ['#/p/example-org%2FSampleApp', { screen: 'project', project: 'example-org/sampleapp', tab: 'now' }],
  ['#/p/example-org%2FSampleApp/work', { screen: 'project', project: 'example-org/sampleapp', tab: 'work' }],
  ['#/p/example-org%2FSampleApp/step/sampleapp-455-telegram-ingest/FIX-455', { screen: 'step', project: 'example-org/sampleapp', work: 'sampleapp-455-telegram-ingest', step: 'FIX-455' }],
  ['#/p/example-org%2FSampleApp/results', { screen: 'project', project: 'example-org/sampleapp', tab: 'results' }],
  ['#/p/example-org%2FSampleApp/cost', { screen: 'project', project: 'example-org/sampleapp', tab: 'cost' }],
  ['#/p/example-org%2FSampleApp/start', { screen: 'start', project: 'example-org/sampleapp' }],
  ['#/p/example-org%2FSampleApp/review/plan-7', { screen: 'review', project: 'example-org/sampleapp', plan: 'plan-7' }],
  // A local project: the opaque ID project connection assigns (#7), never a path.
  ['#/p/local-3f9a2c', { screen: 'project', project: 'local-3f9a2c', tab: 'now' }],
  ['#/p/my.org%2Frepo_name-2/results', { screen: 'project', project: 'my.org/repo_name-2', tab: 'results' }],
];

test('every address parses to its screen and formats back to the same address', () => {
  for (const [address, route] of ADDRESSES) {
    assert.deepEqual(resolveRoute(address), { route, address, replace: false, legacy: null }, address);
    assert.equal(formatRoute(route), address, address);
    // Parsing what formatting produced gives the same route: the address is the state.
    assert.deepEqual(resolveRoute(formatRoute(route)).route, route, address);
  }
  // A project tab of "now" has no suffix; the project's own address is Now.
  assert.equal(formatRoute({ screen: 'project', project: 'example-org/sampleapp', tab: 'now' }), '#/p/example-org%2FSampleApp');
  assert.equal(formatRoute({ screen: 'project', project: 'example-org/sampleapp' }), '#/p/example-org%2FSampleApp');
  // A GitHub project is URL-encoded, so its slash never splits the address.
  assert.equal(formatRoute({ screen: 'step', project: 'example-org/sampleapp', work: 'w', step: 's' }), '#/p/example-org%2FSampleApp/step/w/s');
});

test('an empty address is Projects, rewritten once to #/projects', () => {
  for (const hash of ['', '#', '#/', undefined, null]) {
    assert.deepEqual(resolveRoute(hash), { route: { screen: 'projects' }, address: '#/projects', replace: true, legacy: null }, String(hash));
  }
});

test("today's addresses are redirected once to where their content lives now", () => {
  const expected = { overview: '#/projects', roadmap: '#/settings/diagnostics', work: '#/settings/diagnostics', agents: '#/projects',
    messages: '#/settings/messages', activity: '#/settings/diagnostics' };
  assert.deepEqual({ ...LEGACY }, expected, 'exactly the six views of today, as OWNER_WORKSPACE §9 maps them');
  for (const [name, address] of Object.entries(expected)) {
    for (const hash of [`#${name}`, name]) {
      const resolved = resolveRoute(hash);
      assert.equal(resolved.address, address, hash);
      assert.equal(resolved.replace, true, `${hash} is rewritten with history.replaceState`);
      assert.equal(resolved.legacy, name);
      assert.deepEqual(resolved.route, resolveRoute(address).route);
      // A redirect lands on a canonical address, so it happens once and never again.
      assert.equal(resolveRoute(resolved.address).replace, false);
    }
  }
  assert.throws(() => { LEGACY.overview = '#/needs'; }, TypeError, 'the redirect table cannot be changed at run time');
});

test('unknown, malformed and path-like addresses open Projects', () => {
  const unknown = ['#/nope', '#/projects/other', '#/projects/add/more', '#/needs/x', '#/settings/other', '#/settings/messages/x', '#/p', '#/p/',
    '#/p/example-org%2FSampleApp/', '#/p/example-org%2FSampleApp/unknown', '#/p/example-org%2FSampleApp/step/only-work', '#/p/example-org%2FSampleApp/step/w/s/extra', '#/p/example-org%2FSampleApp/review',
    '#/p/example-org%2FSampleApp/work/extra', '#/p/example-org/sampleapp', '#/p/%E0%A4%A', '#/p/example-org%2FSampleApp/step/%2E%2E/x', '#/P/example-org%2FSampleApp', '#/Projects', '#OVERVIEW',
    '#main', '#overview/x', 'javascript:alert(1)', '#/p/a%2Fb%2Fc', '#/p/%20', '#/p/example-org%2FSampleApp/step/w/s%20x', '#//projects', '#/constructor', '#__proto__', '#toString'];
  // Filesystem paths are never a project address (OWNER_WORKSPACE §3.2, §10.2).
  const paths = ['/home/owner/notes', 'C:\\Users\\owner\\notes', 'C:/example/SampleApp', '../secrets', 'example-org/../x', './x', '..', '~/x', '\\\\server\\share'];
  for (const hash of [...unknown, ...paths.map((path) => `#/p/${encodeURIComponent(path)}`)]) {
    assert.deepEqual(resolveRoute(hash), { route: { screen: 'projects' }, address: '#/projects', replace: true, legacy: null }, hash);
  }
  assert.equal(formatRoute({ screen: 'nope' }), '#/projects');
  assert.equal(formatRoute(null), '#/projects');
});

test('each route belongs to one global place and at most one project tab, for aria-current', () => {
  assert.deepEqual(GLOBAL, ['projects', 'needs', 'settings']);
  assert.deepEqual(TABS, ['now', 'work', 'results', 'cost'], 'four tabs, which fit at 320px');
  const places = Object.fromEntries(ADDRESSES.map(([address, route]) => [address, [globalOf(route), tabOf(route)]]));
  assert.deepEqual(places, {
    '#/projects': ['projects', null], '#/projects/add': ['projects', null], '#/needs': ['needs', null], '#/settings': ['settings', null],
    '#/settings/messages': ['settings', null], '#/settings/diagnostics': ['settings', null],
    '#/p/example-org%2FSampleApp': ['projects', 'now'], '#/p/example-org%2FSampleApp/work': ['projects', 'work'],
    '#/p/example-org%2FSampleApp/step/sampleapp-455-telegram-ingest/FIX-455': ['projects', 'work'], '#/p/example-org%2FSampleApp/results': ['projects', 'results'],
    '#/p/example-org%2FSampleApp/cost': ['projects', 'cost'], '#/p/example-org%2FSampleApp/start': ['projects', 'now'], '#/p/example-org%2FSampleApp/review/plan-7': ['projects', 'now'],
    '#/p/local-3f9a2c': ['projects', 'now'], '#/p/my.org%2Frepo_name-2/results': ['projects', 'results'],
  });
});
