// Parses every campaigns/*.json so a malformed declaration fails the check before a supervisor sees it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'campaigns');
let failed = 0;
for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
  try { JSON.parse(readFileSync(join(dir, name), 'utf8')); }
  catch (error) { failed++; console.error(`campaigns/${name}: ${error.message}`); }
}
if (failed) process.exit(1);
