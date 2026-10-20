// Applies to every project and role, including planning, research and browser checks.
// AI usage is allowed regardless of billing mode. The restriction is on GitHub services.
export const DEVELOPMENT_RESOURCE_RULE = 'For AIWorks and every project it manages, build and test locally. Never create, enable, dispatch or rerun GitHub Actions, including free or self-hosted runners. Never use paid GitHub features or incur GitHub charges: no Codespaces, paid runners, billable Packages or Git LFS storage/bandwidth, paid marketplace services, paid add-ons or GitHub plan upgrades. Do not upload packages or LFS objects, provision GitHub resources, enable paid features or change billing. GitHub repository reads, ordinary Git source hosting, pull requests, issue comments and authorized merges remain allowed with Actions disabled. AI usage is allowed in any billing mode, including subscriptions and metered APIs; this GitHub policy imposes no new AI spending restriction. Existing campaign authority, security controls and configured budgets still apply. Do not bypass required checks or branch protection. Report any requirement that would need a prohibited GitHub feature and use a local alternative where possible.';

// Defence in depth: these complement scoped permissions and the prompt; they do
// not claim to sandbox arbitrary code or control provider-side subscription billing.
export const DEVELOPMENT_DENIED = [
  ...['gh workflow', 'gh run', 'gh actions', 'gh codespace', 'gh codespaces', 'gh cs', 'git lfs push', 'git lfs fetch', 'git lfs pull']
    .flatMap((command) => [`Bash(${command}:*)`, `PowerShell(${command} *)`]),
];

// Ordinary checkout/push must not silently transfer billable LFS objects via
// Git's filters or pre-push hook. Keep all repository security hooks enabled.
export const DEVELOPMENT_ENV = Object.freeze({ GIT_LFS_SKIP_SMUDGE: '1', GIT_LFS_SKIP_PUSH: '1' });
