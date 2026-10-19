// The sample project of First run (docs/design/OWNER_UI_V2.md section 9, work package WP8): a small fictional web app
// on synthetic data that the owner can practise on. AIWorks writes these files into a new or empty folder the owner
// chose, and nowhere else; the folder then goes through the same Add project check and connection as any folder. The
// sample has no rules, no plan, no approval and no budget of its own: nothing runs, and nothing is paid for, until the
// owner confirms its rules and approves a plan exactly as for any other project.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLE_PROJECT = Object.freeze({ id: 'sample-notes', name: 'Sample notes (practice)' });

export const SAMPLE_FILES = Object.freeze({
  'README.md': `# Sample notes

Sample notes is a fictional one-page web app for writing short notes. Notes are kept only in this browser and never leave it. Each note has a title and a body of up to 500 characters.

This project is synthetic: AIWorks wrote it as a practice project, and every name and note in it is made up.

## Ideas for a first goal

- Let people search their notes by title.
- Show how many notes there are.
`,
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sample notes</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>Sample notes</h1>
    <form id="add">
      <label>Title <input name="title" maxlength="80" required></label>
      <label>Note <textarea name="body" maxlength="500" rows="3"></textarea></label>
      <button type="submit">Add note</button>
    </form>
    <ul id="notes" aria-live="polite"></ul>
  </main>
  <script src="notes.js"></script>
</body>
</html>
`,
  'notes.js': `// Sample notes: keeps notes in this browser's local storage only. Fictional practice project.
const KEY = 'sample-notes';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; } };
const list = document.getElementById('notes');

function show() {
  list.replaceChildren(...read().map((note) => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = note.title;
    item.append(title, document.createTextNode(\` \${note.body}\`));
    return item;
  }));
}

document.getElementById('add').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  localStorage.setItem(KEY, JSON.stringify([...read(), { title: String(form.get('title')), body: String(form.get('body') ?? '') }]));
  event.target.reset();
  show();
});

show();
`,
  'style.css': `body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; max-width: 40rem; }
form { display: grid; gap: 0.5rem; margin-bottom: 1rem; }
label { display: grid; gap: 0.25rem; }
`,
});

export class SampleError extends Error {
  constructor(code, message) { super(message); this.name = 'SampleError'; this.code = code; }
}

/** Whether `folder` holds exactly the sample's files, or nothing; anything else is the owner's and is left alone. */
export function sampleFolderState(folder) {
  if (!existsSync(folder)) return 'missing';
  if (!statSync(folder).isDirectory()) return 'other';
  const names = readdirSync(folder);
  if (!names.length) return 'empty';
  const same = names.length === Object.keys(SAMPLE_FILES).length && names.every((name) => Object.hasOwn(SAMPLE_FILES, name) &&
    statSync(join(folder, name)).isFile() && readFileSync(join(folder, name), 'utf8') === SAMPLE_FILES[name]);
  return same ? 'sample' : 'other';
}

/**
 * Prepare `folder` for the sample: create it when it is missing (its parent must exist), and refuse one that holds
 * anything other than the sample. Returns { created }; `undo` removes a folder this call created while it is still
 * empty, for a check that refuses it before anything is written. Nothing is written here.
 */
export function prepareSampleFolder(folder) {
  const state = sampleFolderState(folder);
  if (state === 'other') throw new SampleError('SAMPLE_FOLDER_NOT_EMPTY', 'the folder is not empty');
  if (state !== 'missing') return { created: false, undo: () => {} };
  try { mkdirSync(folder); } catch { throw new SampleError('SAMPLE_FOLDER_UNWRITABLE', 'the folder could not be created'); }
  return { created: true, undo: () => { try { if (!readdirSync(folder).length) rmdirSync(folder); } catch { /* left as it is */ } } };
}

/** Write the sample's files into a folder prepareSampleFolder accepted; a file already the same is left untouched. */
export function writeSampleFiles(folder) {
  if (sampleFolderState(folder) === 'other') throw new SampleError('SAMPLE_FOLDER_NOT_EMPTY', 'the folder is not empty');
  for (const [name, text] of Object.entries(SAMPLE_FILES)) {
    const path = join(folder, name);
    if (!existsSync(path)) writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
  }
}
