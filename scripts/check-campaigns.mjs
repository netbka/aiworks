// CI validates synthetic declarations only. Operator campaigns stay outside the commit scope.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeclaration } from '../src/supervisor/campaign.mjs';

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'tests/fixtures/campaigns');
let failed = 0;
for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
  try { validateDeclaration(JSON.parse(readFileSync(join(dir, name), 'utf8'))); }
  catch { failed++; console.error(`Invalid synthetic declaration: ${name}`); }
}
if (failed) process.exit(1);
