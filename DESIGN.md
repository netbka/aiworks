---
version: alpha
name: AIWorks Owner Workspace
description: A quiet operational workspace that puts owner decisions ahead of machine detail.
colors:
  primary: "#335EEA"
  background: "#F5F7FB"
  surface: "#FFFFFF"
  text: "#202B40"
  muted: "#59677D"
  border: "#E3E8F0"
  selected: "#EDF2FF"
  success: "#14724F"
  successSurface: "#EAF6EF"
  warning: "#805114"
  warningSurface: "#FFF5E5"
typography:
  sans:
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif'
rounded:
  DEFAULT: "12px"
  control: "7px"
spacing:
  page-max: "1400px"
  sidebar: "176px"
  header: "68px"
components:
  button: {}
  panel: {}
  navigation: {}
  field: {}
  dialog: {}
---

# AIWorks design system

## Direction and authority

An owner's control desk: project identity on the left, current state in the middle, next action on the right. The signature is a restrained blue action inside a quiet white workspace. Dense operational detail belongs in disclosures, not competing dashboard tiles.

This is an English product interface for owners supervising local software delivery. There is no evidence of a separate regional market or localization requirement. It supports desktop monitoring and mobile triage. Familiar links, native controls and explicit status words take priority over decorative motion.

The behavioral contract remains [OWNER_WORKSPACE](docs/design/OWNER_WORKSPACE.md), constrained by the [product constitution](docs/PRODUCT_CONSTITUTION.md). Runtime tokens are owned by `src/dashboard/public/dashboard.css` (`:root`); this document mirrors them, not a second generated theme. Presentation tests guard the responsive shell; token changes must update both sources in one change.

## Palette, typography and geometry

White panels sit on a cool gray page. Blue means an action or selected destination; green and amber supplement explicit status text. Do not use green to imply unknown work is healthy. Muted text remains readable. Light mode is the implemented theme; forced-colors mode keeps native scrollbar rendering.

Use the installed Inter font when present, then Segoe UI and Arial; no remote font request. Small operational labels are at least 12px, ordinary content 13–15px, page titles 24px. Numeric readings use tabular numerals. Keep prose left aligned and wrap long project names and evidence.

Desktop uses a full-width 68px header and 176px sidebar. Content is capped at 1400px with 28px vertical and 32px horizontal padding. Panels have 12px corners; controls 7px. Borders carry hierarchy, with shadows reserved for overlays. No ornamental gradients or repeated elevated tiles.

Below 960px navigation moves to the bottom, with focus and scroll clearance. Below 600px rows stack and existing wide tables become labeled cards. Existing large-monitor zoom remains. Preserve browser zoom, keyboard access and text wrapping; never hide an action solely to make a layout fit.

## Canonical UI map

| Capability | Owner | Contract |
| --- | --- | --- |
| Tokens, responsive shell, focus and scrollbars | `dashboard.css` | One palette and geometry across every screen; visible focus and reduced-motion handling |
| Routes, tabs, back links | `router.mjs`, `showRoute`, `routeLink` | Real hash links, browser Back, project context preserved; Home is the first destination and opens for an empty address; a project's tabs are Overview, Plan, Review, Knowledge and, only where a release is configured, Releases (OWNER_UI_V2 section 2), fitting at 320px; old tab addresses redirect once with their drafts |
| Home, Overview, Connections | `homeScreen`, `overviewPanel`, `connectionsScreen` over the server views (`views.mjs`) | Typed events in page words only; Built, Checked and Available to users stay apart and unknown stays unknown; pause controls name stopping and stopped |
| Plan | `planScreen` over `work.plans` (`work.mjs`) | Now, Next and Later from the plan's own outline; version history from stored drafts only; Edit plan continues on Review as Review's draft; approval only on Review, for the version shown |
| Decision card | `decisionPanel` | One card on the step and on Home's first decision; options with consequences, suggestion, snooze and "did not need me" |
| Result Review | `reviewPanel` on the step; `reviewEntry` rows (`owner.mjs`) on the Review tab, Home and Overview | One project, goal and step identity everywhere; accept and request changes bind the verified head and report; "Accepted" only from recorded acceptance |
| Idea-first start | `ideaPanel` on Add project | The idea stays a draft until the owner connects a folder; then it is the project's unsent Plan work goal; nothing is provisioned or dispatched before approval |
| Buttons, panels, badges | `dashboard.js` helpers + shared CSS | One emphasis hierarchy; words accompany status color |
| Needs you | `needsItem`, `needsGroups`, `attentionSummary` | Derive counts from server evidence; preserve unknown merge checks; open real issue/PR links |
| Project list | `projectsScreen` | Identity, state and next action remain separate; details remain available |
| Text and number field errors | `validateForm` | Trim required values, inline error with aria-invalid/describedby, focus first invalid field |
| Select/listbox and radio choices | Native HTML | Platform popup and keyboard behavior; product owns labels and surrounding appearance |
| Dialogs and destructive commands | Existing dialog handlers and command helpers | Confirm destructive actions, preserve cancellation and server receipts |
| Async refresh and drafts | Existing route patching, draft storage and notices | Poll without resetting focus, scroll, open disclosures or unsent text; preserve retry/error states |
| Loading and unavailable data | Existing connection, pending and unavailable helpers | Text identifies waiting or missing evidence; never substitute zero |
| Search | Existing work filters + clear-search | Clear resets the query and restores focus; other filters remain |

## Components and behavior

Primary blue buttons represent the next useful action. Secondary buttons are white. Buttons have visible hover, pressed and focus states; disabled buttons retain their label. Busy commands use the established pending state to prevent repeat submissions. Destructive commands stay separated and retain their confirmation dialog.

Needs you uses neutral cards with a small amber action label, a readable subject, real evidence and a clear link. Supporting impact is separated by a subtle divider. Do not wrap a full page of requests in warning-colored panels. The Projects summary uses the same server count as Needs you; unknown evidence stays visibly qualified. Work's single active-worker metric is compact rather than an isolated quarter-width KPI card.

Needs you, Projects and Results share the same merge evidence. A recorded merge bound to the verified commit and published PR remains merged after refresh or a change in repository history. Without that receipt, the current base-branch check determines the state. A historical merge does not imply deployment or availability to users.

Plan work always explains what submission permits. Plan only proposes steps without changing the project. When planning is enabled for a connected project, Plan and do drafts a plan for Review; nothing starts until the owner chooses Approve and start. Projects without GitHub first need confirmed rules. An unavailable execution mode is explained in a disclosure. Existing `/start` routes stay compatible. Merge and release remain separate permissions.

Forms use persistent labels and inline validation, with no browser validation bubbles for the changed plan, instruction and message forms. Textareas keep stable geometry and scroll internally. Native dialogs retain their existing focus and Escape behavior. Navigation icons are small inline stroke SVGs with visible text labels; decorative icons are hidden from assistive technology.

No new animation is introduced. Existing refresh effects respect reduced-motion preferences. Keep server errors, retries, partial results and historical evidence visible; polish must not erase uncertainty or authorization boundaries.

Long report and plan text can be checking, available or unavailable independently of the work's delivery state. Unchecked text stays hidden; an unfinished check is never labeled a secret. Review explains when its details are still being checked and keeps approval and editing unavailable until that check completes. These display states never change the stored plan or its authority.

## Verification

Use the synthetic `tests/dashboard/fixtures/review-store.mjs` dashboard for screenshots and browser checks, never a live installation. Its full store has Plan and do and Add project on, plans with several versions in Now, Next and Later, an out-of-date plan, results waiting for review and a report recorded in the local work list. Check desktop and narrow (320–390px) Home, Projects, Needs you, the project tabs (Overview, Plan, Review, Knowledge, and Releases where configured), a plan's Review, Plan work, Add project, Settings and Connections; check keyboard focus, form errors, route/draft retention and query clearing. Run the repository checks. Synthetic previews and passing source tests are not evidence of a production deployment.
