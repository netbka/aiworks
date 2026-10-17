import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read all stdin safely
let input = '';
try {
  if (!process.stdin.isTTY) {
    input = readFileSync(0, 'utf8');
  }
} catch {
  input = '{}';
}

let payload = {};
try {
  payload = input ? JSON.parse(input) : {};
} catch {
  payload = {};
}

// Find repository root (one level up from .agents)
const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, '..');

// Helper to check git status
function isBehindOriginMain() {
  try {
    const status = execSync('git status -uno', { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return status.includes("behind 'origin/main'");
  } catch {
    return false;
  }
}

// Prohibited internal words on owner-facing screens (OWNER_WORKSPACE §2.2 / AGENTS.md)
const FORBIDDEN_WORDS = [
  { pattern: /\bsupervisors?\b/i, name: 'supervisor' },
  { pattern: /\bcoordinator\b/i, name: 'coordinator' },
  { pattern: /\bcampaigns?\b/i, name: 'campaign' },
  { pattern: /\bcontrollers?\b/i, name: 'controller' },
  { pattern: /\bexecutors?\b/i, name: 'executor' },
  { pattern: /\bthe task\b/i, name: 'the task' },
  { pattern: /(?<!Cursor )\bagents?\b/i, name: 'agent' }
];

// PreToolUse handler (payload has toolCall)
if (payload.toolCall) {
  const toolName = payload.toolCall.name || '';
  const args = payload.toolCall.args || {};

  // 1. Guard against modifying code while behind origin/main
  if (['replace_file_content', 'write_to_file'].includes(toolName)) {
    if (isBehindOriginMain()) {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: 'BLOCKED BY GOVERNANCE HOOK: Local branch is behind origin/main. You must pull latest origin/main before modifying code (AGENTS.md § Review and runtime maintenance).'
      }));
      process.exit(0);
    }

    // 2. Guard against adding forbidden machine words into dashboard client code
    const target = normalize(args.TargetFile || '');
    if (target.includes('src/dashboard/public') || target.includes('src\\dashboard\\public')) {
      const content = args.ReplacementContent || args.CodeContent || '';
      for (const { pattern, name } of FORBIDDEN_WORDS) {
        if (pattern.test(content)) {
          console.log(JSON.stringify({
            decision: 'deny',
            reason: `BLOCKED BY GOVERNANCE HOOK: Found prohibited internal word "${name}" in dashboard copy. Owner-facing screens must use owner words (AI worker, Planner, etc.). See AGENTS.md and tests/dashboard/fixtures/page.mjs.`
          }));
          process.exit(0);
        }
      }
    }
  }

  // 3. Guard against destructive git commands
  if (toolName === 'run_command') {
    const cmd = args.CommandLine || '';
    if (/git\s+push\s+.*(?:--force|-f\b)/i.test(cmd)) {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: 'BLOCKED BY GOVERNANCE HOOK: Force-push is strictly prohibited (AGENTS.md § Authorized work).'
      }));
      process.exit(0);
    }
    if (/git\s+(?:rebase|reset\s+--hard)/i.test(cmd)) {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: 'BLOCKED BY GOVERNANCE HOOK: Destructive git reset/rebase is prohibited on shared runtime branch (AGENTS.md).'
      }));
      process.exit(0);
    }
  }

  // Default allow
  console.log(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

// PreInvocation handler (payload has invocationNum or general prompt)
const reminder = [
  'MANDATORY PROJECT GOVERNANCE (AGENTS.md):',
  '1. Always verify git status and ensure local head matches origin/main before editing code or running tests.',
  '2. Read AGENTS.md, docs/PRODUCT_CONSTITUTION.md, and docs/SUPERVISOR.md for operational boundaries.',
  '3. Strict OWNER WORDS policy: never output internal machine words (supervisor, coordinator, campaign, controller, agent, the task) on owner-facing screens or copy.',
  '4. Full validation: run `npm run check` on the reviewed revision before completing tasks.'
].join('\n');

console.log(JSON.stringify({
  injectSteps: [
    {
      ephemeralMessage: reminder
    }
  ]
}));
process.exit(0);
