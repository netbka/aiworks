# Static showcase

`index.html` is a one-page walk through the owner journey of the [acceptance record](../docs/design/OWNER_JOURNEY_ACCEPTANCE.md), with screenshots from its synthetic runtime. It is published on GitHub Pages at <https://netbka.github.io/aiworks/> from the `gh-pages` branch; no workflow file in this repository builds or publishes it.

## Preview it

Open `site/index.html` in a browser from a checkout. There is no build step and no dependency. The page loads only `showcase.css` and the images in `assets/`; its content security policy refuses every other request, so it makes no external call. Links to the documentation are relative to this repository (`../docs/…`); a copy of `site/` published on its own needs them pointed at the repository's documentation.

## Publish it

The `gh-pages` branch holds only a copy of `site/` plus an empty `.nojekyll`, with every `../` link rewritten to `https://github.com/netbka/aiworks/blob/main/`. To publish a change, merge it to `main`, then rebuild that branch from the merged `site/` the same way and push it. GitHub Pages serves the branch root through GitHub's own Pages job (the owner's one exception to the no-Actions rule); never add a workflow file for it.

## What the page may say

These rules cover `index.html`. The Russian section `cases/` is different: see below.

- Only what the owner journey demonstrated, labelled *Shown in this demonstration*. Code that exists but is off by default, or was not exercised, says so. Owner-reserved configuration (alert recipients, release destinations, remote access) is named as such.
- Nothing about an installed or running copy, and no deployment claim.
- Fictional projects and names only. No account, host, project inventory, run metrics, credentials or worker output from a real run.

## The `cases/` section

`cases/` is a short Russian walk through how the owner uses AIWorks on three real projects (owner request, 21 November 2026). It names the owner's own products (ELMA Wiki, Growth Farm, ELMA MCP) and the public platforms they work with (ELMA 365, 1C, Redmine), each explained in a sentence or two. It never names a company, person, host, private repository, account or credential, and gives no run metrics beyond rounded examples. Plain HTML and `cases.css` on top of `showcase.css`, same content security policy, no build step. Publish it with the rest of `site/`.

## Capture the screenshots again

Windows with Chrome installed. `<folder>` must be new or empty and outside every Git repository and the home folder (the journey script explains why). Commit first: `journey.json` records the source commit and whether the checkout had uncommitted changes.

```sh
npm install
node scripts/supervisor/owner-journey.mjs journey <folder>
```

Every step must print `ok`. Each screenshot names the computer "Example PC" instead of its real name. For the screens the journey does not capture itself, start the finished runtime again and take them:

```sh
node scripts/supervisor/owner-journey.mjs start <folder>
node scripts/supervisor/owner-journey.mjs eval <folder> "location.href = '<url from <folder>/pids.json>#/'; return 1;"
node scripts/supervisor/owner-journey.mjs eval <folder> "location.hash = '#/p/site/releases'; await sleep(3000); return 1;"
node scripts/supervisor/owner-journey.mjs shot <folder> 06-releases-local
#   likewise #/settings/alerts as 07-settings-alerts and #/p/notes/plan as 08-plan;
#   #/p/notes/review as 11-phone-review and #/ as 12-phone-home, each with: shot <folder> <name> 390 844
node scripts/supervisor/owner-journey.mjs stop <folder>
```

Then copy from `<folder>/evidence` into `site/assets`:

| Evidence file | Asset |
| --- | --- |
| `01-home-empty.png` | `home-empty.png` |
| `03-review-v2.png` | `plan-review.png` |
| `08-plan.png` | `plan-versions.png` |
| `04-review-preview.png` | `result-review.png` |
| `05-home-decided.png` | `decision.png` |
| `06-releases-local.png` | `releases.png` |
| `07-settings-alerts.png` | `alerts.png` |
| `12-phone-home.png` | `phone-home.png` |
| `11-phone-review.png` | `phone-review.png` |

Look at every image before committing it, and update the page's text where a screen changed. Leave `journey.json` and the rest of `<folder>` outside the repository.

## Current assets

Captured on 2026-11-11 by the journey above from source commit `808d8d1` with no uncommitted changes, all 52 steps `ok`. Home while a step is checked replaces the earlier decision screen: under AW-017 the journey's builder decides for itself, so no decision waits for the owner.
