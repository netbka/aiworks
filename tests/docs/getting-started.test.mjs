import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeclaration } from '../../src/supervisor/campaign.mjs';
import { coordinatorConfigError, containsSecret } from '../../src/supervisor/coordinator.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const exampleRoot = 'docs/guides/examples/';
const campaign = JSON.parse(read(`${exampleRoot}campaign-report.example.json`));
const config = JSON.parse(read(`${exampleRoot}config.example.json`));

function markdownFiles(path) {
  return readdirSync(resolve(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory() ? markdownFiles(child) : entry.name.endsWith('.md') ? [child] : [];
  });
}

// Documentation/shape regressions, not real provider or runtime acceptance.
test('first-report example passes the production declaration validator and remains inert', () => {
  assert.doesNotThrow(() => validateDeclaration(campaign));
  assert.match(campaign.authorization.text, /EXAMPLE ONLY/);
  assert.equal(campaign.target.repository, 'example/project');
  assert.equal(campaign.executor.researchOnly, true);
  assert.ok(campaign.tasks.every((task) => task.deliverable === 'report'));
  assert.equal(existsSync(resolve(root, 'campaigns', 'example-readme-report.json')), false);
});

test('example coordinator configuration has a valid cross-platform shape, but is disabled', () => {
  // Validate absolute path shape on the test host; this is not Windows execution.
  const coordinator = { ...config.coordinator,
    sourceRepo: root,
    runtimeRoot: resolve(root, '.local/runtime'),
    worktreeRoot: resolve(root, '.local/worktrees/aiworks'),
  };
  assert.equal(coordinatorConfigError(coordinator), null);
  assert.equal(config.coordinator.enabled, false);
  assert.equal(config.coordinator.permissionMode, 'dontAsk');
  assert.equal(config.coordinator.reportTo, 'example/project#1');
  for (const [name, args] of Object.entries(config.commands)) {
    assert.ok(Array.isArray(args) && args.length === 1, name);
    assert.match(args[0], /^[A-Z]:\/.+\.exe$/i, name);
  }
  for (const value of [config.governanceRoot, config.coordinator.sourceRepo,
    config.coordinator.runtimeRoot, config.coordinator.worktreeRoot]) {
    assert.match(value, /^[A-Z]:\//i);
  }
});

test('example JSON contains no credential material or unreviewed feature enablement', () => {
  assert.equal(containsSecret(JSON.stringify(config)), false);
  assert.equal(containsSecret(JSON.stringify(campaign)), false);
  assert.equal(config.release, undefined);
  assert.equal(config.scheduler, undefined);
  assert.equal(config.ownerIntervention, undefined);
  assert.equal(config.routing, undefined);
});

test('new guide and contribution links resolve inside the repository', () => {
  const paths = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md',
    ...markdownFiles('docs/guides'), ...markdownFiles('docs/publication')];
  for (const path of paths) {
    const text = read(path).replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#')) continue;
      const target = decodeURIComponent(href.split('#')[0]);
      const absolute = resolve(root, dirname(path), target);
      const rel = relative(root, absolute);
      assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`), `${path}: escaping link ${href}`);
      assert.ok(existsSync(absolute), `${path}: missing link ${href}`);
    }
  }
});

test('documented CLI verbs exist; planning is not represented as campaign dispatch', () => {
  const cli = read('src/supervisor/cli.mjs');
  for (const verb of ['serve', 'keep', 'stop', 'start', 'status', 'pause', 'cancel', 'recheck', 'message', 'messages', 'baseline']) {
    assert.ok(cli.includes(`command === '${verb}'`), `missing CLI command: ${verb}`);
  }
  // Execution contracts moved out of the beginner guide, not out of the product.
  const instructions = read('docs/guides/ASSISTANT_SETUP.md');
  assert.match(instructions, /read-only planning request/);
  assert.match(instructions, /does not expose a public `campaign_start` MCP tool/);
  assert.match(instructions, /prepared, queued or not-yet-dispatched command has not run/);
  assert.match(instructions, /reconcile/i);
  assert.match(read('docs/guides/CLI_REFERENCE.md'), /successful start response alone does not prove work has begun/);
});

test('showcase documentation explicitly defers implementation until dashboard acceptance', () => {
  const checklist = read('docs/publication/RELEASE_CHECKLIST.md');
  assert.match(checklist, /Deferred website: do not build yet/);
  assert.match(checklist, /independent UX acceptance/);
  assert.match(checklist, /issue #99/);
  assert.match(checklist, /public deployment additionally requires/);
});

test('README setup through an AI assistant is a short prompt that points at the setup guide', () => {
  const text = read('README.md').replace(/\r\n/g, '\n');
  const at = text.indexOf('### Set it up with your AI assistant');
  assert.ok(at > 0, 'the README keeps its AI-assisted setup section');
  const section = text.slice(at, text.indexOf('\n### ', at + 1));
  const prompt = /```text\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(prompt, 'a copyable AI message');
  assert.ok(prompt.trim().split(/\s+/).length <= 100, 'the setup message stays short');
  assert.match(prompt, /https:\/\/github\.com\/netbka\/aiworks/);
  assert.match(prompt, /docs\/guides\/ASSISTANT_SETUP\.md/);
  assert.doesNotMatch(prompt, /<[^>]+>/, 'no technical fields for the beginner to fill in');
  assert.match(section, /\]\(docs\/guides\/README\.md\)/, 'the section links the getting-started guides');
  assert.match(text, /### Start here\n/, 'preserve the engineering reading-list anchor');
});

test('beginner pages use prompts; Gemini setup is not advertised as a built-in worker', () => {
  const guide = read('docs/guides/AI_ASSISTED_START.md');
  for (const client of ['Codex', 'Claude Code', 'Cursor', 'Gemini CLI']) assert.ok(guide.includes(client));
  assert.match(guide, /Gemini CLI is a setup assistant here, not a built-in AIWorks worker/);
  assert.match(guide, /not a claim that every client\/version has passed/);
  assert.match(guide, /web chat cannot start a program.*without an authorized connection/);
  for (const path of ['docs/guides/README.md', 'docs/guides/AI_ASSISTED_START.md',
    'docs/guides/INSTALLATION.md', 'docs/guides/FIRST_PROJECT.md']) {
    const text = read(path);
    assert.doesNotMatch(text, /```(?:powershell|bash|sh|shell|json)\b/, `${path}: keep shell setup in the manual guides`);
  }
  assert.match(read('docs/guides/INSTALLATION.md'), /not yet a one-click public installer/);
  assert.match(read('docs/guides/MANUAL_INSTALLATION.md'), /npm ci/);
  assert.match(read('docs/guides/CLI_REFERENCE.md'), /cli\.mjs start/);
});
