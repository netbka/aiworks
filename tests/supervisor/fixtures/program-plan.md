# Sample plan (synthetic fixture for tests/supervisor/program-plan.test.mjs)

## 5. Before the build order

A slice table outside section 6 is not part of the build order.

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **OUT1** | Never parsed. | `sup/outside.mjs` | none | None | No |

## 6. Build order

### 6.2 Rules

Paths: `sup/` is `src/supervisor/`, `ts/` is `tests/supervisor/`. "SUPERVISOR.md" is `docs/SUPERVISOR.md`.

### 6.3 Lane AAA - the first lane

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **AAA1** | The base module exists. | `sup/base.mjs` (new), `ts/base.test.mjs` (new) | none | The base test passes | No |
| **AAA2** | The next module builds on the base. | `sup/next.mjs` (new), `ts/next.test.mjs` (new) | AAA1 | The next test passes | No |
| **AAA3** | The shared module gets its second change. | `sup/shared.mjs` (second turn), `ts/aaa3.test.mjs` (new) | none | The shared test passes | No |
| **AAA4** | A slice that is already done. | `sup/done.mjs` (new) | none | The done test passes | No |
| **AAA5** | A slice that is running now. | `sup/running.mjs` (new) | none | The running test passes | No |
| **AAA6** | A slice that builds on finished work. | `sup/after.mjs` (new), SUPERVISOR.md (one section) | AAA4 (`sup/done.mjs`) | The after test passes; the runbook section exists | No |

### 6.4 Lane BBB - the second lane

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **BBB1** | The shared module gets its first change. | `sup/shared.mjs` (first turn), `ts/bbb1.test.mjs` (new) | none | The first shared test passes | No |
| **BBB2** | The live install switches on. Runbook only. | SUPERVISOR.md (switch on, switch back) | none | Status before and after | No |
| **BBB3** | A slice the record excludes. | `sup/excluded.mjs` (new) | none | The excluded test passes | No |

### 6.5 Lane CCC - a lane the record does not allow

| ID | Outcome | Owns | Depends on | Tests | Owner decision |
| --- | --- | --- | --- | --- | --- |
| **CCC1** | A slice outside the record. | `sup/other.mjs` (new) | none | The other test passes | No |

### 6.9 Shared files

**Turn order:** BBB1 → AAA3 → AAA6 → BBB2.

| Shared file | Writers, in order |
| --- | --- |
| `sup/shared.mjs` | BBB1, AAA3 |
| `docs/SUPERVISOR.md` | AAA6, BBB2 (switch on last) |

## 7. After the build order

Nothing here is parsed.
