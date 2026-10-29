// Machine text in owner words (OWNER_UI_V2): a coordinator reply is shown without commit hashes, file paths, run ids or
// campaign ids. Only text AIWorks or an AI worker wrote gets that; what the owner typed is shown as typed. A pause reason is
// typed text, so only the ids of known campaigns and their runs are put in words there. The stored text is unchanged:
// these only shape what the page shows.

const HASH = String.raw`(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}`;
const NAMED_HASH = new RegExp(String.raw`\b(?:(?:the|a|its|exact)\s+)*(?:commit|revision|sha|head)\s+${HASH}\b`, 'gi');
const BARE_HASH = new RegExp(String.raw`\b${HASH}\b`, 'g');
// A path with a folder (src/dashboard/main.mjs:35, D:\work\notes.txt) or a source file name with a line (main.mjs:35).
const PATH = /(?<![\w/\\.:-])(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]*\.[A-Za-z]\w{0,7}(?::\d+){0,2}(?![\w/\\])/g;
const FILE_LINE = /\b[\w-]+\.(?:m?js|cjs|jsx?|tsx?|json|md|css|html|py|ps1|sql|ya?ml)(?::\d+){1,2}\b/g;
const RUN_ID = /\b(?:(?:the|a|its)\s+)?(?:run\s+)?(?:coordinator|intake)\.\d{10,}\b/gi;
const WORK_ITEM = /\baiworks-work:(\d+)\b/g;
// A dated work slug such as notes-search-20260101, with any step or run suffix.
const SLUG = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{8}(?:[./][\w.-]+)*\b/g;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces the ids of known campaigns, and their runs and steps. `names` maps a campaign id to the words that name it. */
function withoutCampaignIds(text, names) {
  let out = String(text ?? '');
  // Longest first, so a campaign id that starts another is never half replaced.
  for (const [id, words] of [...names].sort(([a], [b]) => b.length - a.length)) {
    if (!id) continue;
    // A run or a step named by the work's id says whose it is: "a run of “Tag recipes”", never "recipes-tags run 3".
    const named = String.raw`(?:\b(?:the\s+)?campaign\s+)?(?<![\w-])${escape(id)}`;
    out = out.replace(new RegExp(String.raw`${named}(?:'s)?\s+(?:run|attempt)\s*#?\d+\b`, 'gi'), `a run of ${words}`)
      .replace(new RegExp(String.raw`${named}\s+T\d+\b`, 'gi'), `a step of ${words}`)
      .replace(new RegExp(String.raw`${named}(?:[./][\w.-]+)*(?![\w-])`, 'gi'), words);
  }
  return out;
}

/** Replaces internal identifiers in AIWorks-written text. `names` maps a campaign id to the words that name it. */
export function withoutInternalIds(text, names = new Map()) {
  return withoutCampaignIds(text, names).replace(RUN_ID, 'AIWorks').replace(WORK_ITEM, 'work item $1').replace(SLUG, 'other work')
    .replace(NAMED_HASH, 'a commit').replace(BARE_HASH, 'a commit').replace(PATH, 'a project file').replace(FILE_LINE, 'a project file')
    .replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1');
}

/** Markdown markup as plain text: headings, emphasis, code marks and tables without their symbols. */
function plainMarkdown(text) {
  const lines = text.split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) continue;
    if (/^\s*\|?\s*:?-{3,}/.test(line) && line.includes('|')) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // A table's header row (the row above its |---| row) is dropped; every other row becomes one line.
      if (/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) continue;
      out.push(`• ${line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|')).filter(Boolean).join(' · ')}`);
      continue;
    }
    out.push(line.replace(/^(\s*)#{1,6}\s+/, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]*)`/g, '$1'));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The fixed lines replyBody (src/supervisor/coordinator.mjs) puts around the coordinator's own text.
const SUMMARY = '**Summary:** ';
const CLOSING = /\n*Read-only planning by the AIWorks coordinator\.[^\n]*\s*$/;
const HEADINGS = { '### Work reviewed': '### Work AIWorks looked at', '### Proposed execution plan': '### Proposed plan' };

// A fixed explanation, never a fragment of the withheld answer. The reply composer remains the recovery route.
export const WITHHELD_REPLY = 'This answer is hidden because it may contain private information. Ask AIWorks for a new summary without passwords, keys or other private details.';

/**
 * A stored coordinator reply (replyParts text) as the owner reads it in Chats: the summary, the answer and the plan, in
 * plain words. The reply's own heading, its run and message numbers and its quote of the owner's message are left out:
 * the owner's message is shown in full beside it. A body of any other shape is kept whole, only made plain.
 */
export function ownerReply(body, names = new Map()) {
  let text = String(body ?? '');
  const start = text.indexOf(`\n${SUMMARY}`);
  if (text.startsWith('## Coordinator reply\n') && start >= 0) text = `Summary: ${text.slice(start + SUMMARY.length + 1)}`;
  text = text.replace(CLOSING, '');
  for (const [heading, words] of Object.entries(HEADINGS)) text = text.split(`\n${heading}\n`).join(`\n${words}\n`);
  return withoutInternalIds(plainMarkdown(text), names);
}

const REBUILD = /^AIWorks rebuild \S+: paused for maintenance\b/;

/**
 * A pause reason, whole and as typed. The rebuild's own reason gets fixed words; in any other reason only the ids of known
 * campaigns (and their runs and steps) are put in words. An id that is an ordinary word (no hyphen, dot or digit) is left
 * alone, so no typed word is ever rewritten.
 */
export function ownerPauseReason(reason, names = new Map()) {
  const raw = String(reason ?? '').trim();
  if (!raw) return null;
  if (REBUILD.test(raw)) return 'Paused while AIWorks is updated on this computer; it resumes when the update finishes';
  return withoutCampaignIds(raw, new Map([...names].filter(([id]) => /[-.\d]/.test(id))));
}
