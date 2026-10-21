#!/usr/bin/env node
// The disposable release rehearsal (docs/SUPERVISOR.md section 12): whole releases through the production release code
// against a synthetic project, grant and site folder in a new temporary directory, removed afterwards. It reads no
// installation data and needs no data directory: release.enabled is true only in the rehearsal's own memory.
//   node scripts/supervisor/release-rehearsal.mjs [--json]
// Exit 0 when every scenario held, 1 otherwise.
import { rehearsalText, rehearseRelease } from '../../src/supervisor/release/rehearsal.mjs';

const result = await rehearseRelease();
console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : rehearsalText(result));
process.exitCode = result.passed ? 0 : 1;
