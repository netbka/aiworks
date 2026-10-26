# UI inventory

Status: draft for the owner's review, 2026-10-25.

What the owner dashboard is made of today, counted from the running interface rather than from intent. It is the starting point for the interface specification: before deciding how things should look, we list what exists and how many variants of each thing there are.

**Reference products.** The owner chose GitHub and Linear as the products AIWorks should feel like. Wherever this document says "the reference", it means the matching pattern in one of those two. The vocabulary that goes with them is in [UI_GLOSSARY.md](UI_GLOSSARY.md).

**How it was measured.** The synthetic dashboard (`tests/dashboard/fixtures/review-store.mjs`, full store) was opened in headless Chromium. A crawler followed every in-app link from Home and the global screens and visited 60 addresses. On each one it took a full-page screenshot at 1440 × 900 and at 390 × 844, and recorded the computed style and text of every visible button, badge, tab, field, disclosure, heading, table and dialog. "Looks" below means a distinct combination of tag, background, text color, size, weight, corner radius, padding and border. Counts are uses across the 60 pages, so a component that repeats in a list counts once per row.

## 1. Screens

24 kinds of screen. Every one keeps the same shell: a 68px header, a 176px sidebar on desktop and a bottom bar under 960px. No screen scrolls sideways at 390px.

| Area | Screens | Title (h1) | Reference pattern |
| --- | --- | --- | --- |
| Global | Home, Projects, Needs you, Chats, Chat, Work list, Work item, Add project | Home · Projects · Needs you · Chats · Chats · Work list · Work item #n · Add project | Linear Inbox (Needs you), Linear Projects list, GitHub new repository |
| Project tabs | Overview, Plan, Review, Releases, Knowledge | project name · Plan · Review · Releases · Knowledge | Linear project page with tabs, GitHub repository tabs |
| Inside a project | Step, Plan work, Project settings, a plan's review | Step · Plan work · Project settings | Linear issue page, GitHub pull request page |
| Settings | Settings, Diagnostics, Worker accounts, Version and roadmap, Model instructions, Connections, Alerts, Usage | as named | GitHub Settings with a left section list |

Each page carries an eyebrow above the title ("AIWORKS", "SETTINGS", "PROJECT · SHOP-APP") and a question below it ("Which project should I open?"). Neither the reference products nor most owner tools use the question line; it costs a line on every screen, including on phones.

## 2. Components

| Component | Looks | Uses | What the variants are | Verdict |
| --- | --- | --- | --- | --- |
| Button | 9 | 211 | Primary and secondary, each in regular (13px) and small (12px); the same four again as links styled as buttons; a text link button; a small danger button; a small primary button used once (Resume goal) | The set is sound: four sizes/emphases plus danger. Links and buttons that look the same is fine. The small primary is an orphan. |
| Status badge | 10 | 208 | Two parallel systems: `badge` (5px corners, 4/7px padding, weight 550) and `account-pill` (6px corners, 3/8px padding, weight 600) with near-identical colors | Merge into one badge. 37 distinct status words, see §4. |
| Navigation item | 2 | 240 | Sidebar item, active sidebar item | Consistent. |
| Tab | 2 | 180 | Tab, active tab | Consistent. Step and Plan work keep the project tabs and mark one active, so the active tab does not say where you are. |
| Text field | 7 | 72 | Styled textarea, styled input and select at 12px text; native radio buttons; the chat reply box is an unstyled native textarea (square corners, darker border, 14px); the search box has its own padding for a search icon; two filter selects with a different border and 8px corners | Typed text at 12px is below the 13px content minimum in DESIGN.md. The chat box and filter selects sit outside the system. |
| Disclosure (+ Details) | 5 | 110 | The same summary with five different paddings | 102 of 110 say "Details". It has become the default place for anything that did not fit. |
| Heading | 8 | 216 | h2 at 16px (114 uses), two h3 styles at 13px muted and 14px dark, h4 at 14px, a muted 13px h2, and one 26px h2 ("Your work, at a glance") that is larger than the 24px page title above it | Needs a fixed scale: page title, section title, item title, group label. |
| Table | 2 | 72 | Used only on two screens | Fine. Below 600px they become cards, as designed. |
| Dialog | 1 | about 15 per page | One look for every confirm and form dialog | Consistent. |
| Diagram, chart, graph | 0 | 0 | No diagram exists in the dashboard. The only graphic is the Goals row's three colored bars | The bars are full-width lines whatever the count ("1 of 2" draws a full bar), so they read as decoration, not progress. |

The tokens in DESIGN.md hold up at the level of single elements: every button, tab and dialog draws from the same palette, radius and font. The inconsistency is one level up, in how elements are combined into cards, rows and pages, and in the words.

## 3. Findings

Ordered by how much they cost the owner. "Reference" says what GitHub or Linear does instead.

1. **Several names for one thing.** The big unit of work is a "goal", "work", "a piece of work", "campaign" or "track" depending on the screen ("campaign" is visible on screen three times). A step is also a "task" on 12 places. The second AI is the "checker", "independent check", "verifying" and "being checked". "Check again" means *retry*, so the word "check" means two different things on the same card. Full mapping in [UI_GLOSSARY.md](UI_GLOSSARY.md). *Reference:* Linear and GitHub use one word per object everywhere: issue, pull request, project.
2. **Same project, different status on two screens.** In the same run, Home showed recipes as "Review ready" and shop-app as "Review ready", while Projects showed them as "Needs setup" and "Possibly stuck". The two screens compute their summary differently. *Reference:* a status is a property of the object and reads the same in every list.
3. **37 status words, no lifecycle.** A step can be Not started, In an approved plan, Waiting, Being built, Being checked, Passed the check, Passed, Published merge not seen yet, Review ready, Merged, Report posted, Blocked, Possibly stuck, Result not known, Not checked and more. The same fact gets two colors: "Passed the check" is blue (in progress), "Passed" is green (done). Model attributes such as "Deep thinking" or "Security-critical" use the amber of a warning. *Reference:* Linear has one ordered set of states per team (Backlog, Todo, In Progress, In Review, Done, Canceled), each with one color and icon; labels are a separate, neutral-colored concept.
4. **"Unknown" looks like "needs attention".** Result not known, Not checked and Possibly stuck share the amber family with Needs you and Blocked. DESIGN.md requires unknown to stay visibly unknown, not alarming. *Reference:* GitHub draws pending and skipped checks in neutral gray with their own icon.
5. **Cards in one list are built differently.** On Needs you, some cards have a goal line, a badge, a title and an explanation; system-trouble cards ("AIWorks is running, but last checked…") have no badge and put the explanation in a gray band; the resolution area ranges from one button to a full form with radios and a textarea, so cards vary from about 250 to over 700 pixels tall. *Reference:* Linear Inbox rows are identical in shape; the full context opens beside the list, not inside it.
6. **Results are walls of text.** Each Review row prints a title, two links, two status sentences, a five-part Yes/No line (Implemented, Independently checked, Merged, Deployed, Release checked), a fixed sentence repeated on every row ("Review only: AIWorks does not deploy this result…"), a disclosure and the goal name *after* the row it belongs to. *Reference:* a GitHub pull request list row is one line: title, status icon, checks summary, author, age.
7. **The step page does not say which step.** Its title is the word "Step"; the step's real name is the first card's heading; the active tab is Review or Overview depending on its state. There is no breadcrumb from project to goal to step. *Reference:* Linear and GitHub put the item's own title in the page title and a breadcrumb above it (Team › Project › Issue).
8. **Internal references leak.** The header shows the version and release codename on every screen ("v0.9.0 · Model Routing & Task Signatures"); results and Needs you cards lead with pull request numbers; "invalid result" appears as a reason. DESIGN.md asks for business words only. *Reference:* GitHub keeps commit hashes and numbers as secondary, monospaced metadata.
9. **Rows have no grid.** On Projects the status column starts at a different horizontal position on each row (roughly 30px apart across three rows at 1440 wide), because it starts where the name ends. *Reference:* list rows in both products align columns.
10. **The sidebar background stops at 900px** on pages taller than the window, leaving the lower left white-on-gray. Every page's title also shows a focus outline after navigation, because focus moves to it visibly.
11. **"Details" holds what did not fit.** 102 disclosures on 60 pages. Owners learn that the important line may be inside one. *Reference:* GitHub shows the summary and puts full detail on the item's own page.
12. **Pending counts jump.** The Needs you badge reads "7 + checking" until GitHub answers, then 13. The page needs one agreed way to show a count that is still arriving.

## 4. Status words in use

Grouped by what they actually mean, as input to the status set in the glossary.

| Meaning | Words on screen today |
| --- | --- |
| Not begun | Not started, In an approved plan, Suggested by AI, Waiting, Waiting for merges, Not available |
| AI working | Being built, Being checked, Working on…, Checking… |
| Waiting on the owner | Needs you, Needs setup, Review ready, Decision needed, Changes requested · not being made |
| Passed, not merged | Passed the check, Passed, Published, merge not seen yet, Checked on this computer · not merged yet |
| Finished | Merged, Report posted |
| In trouble | Blocked, Possibly stuck, Stopped; will not retry by itself |
| Unknown | Result not known, Not checked, Not recorded |
| Not statuses (attributes) | On, Active, Active now, Default, Core role, Economy, Fast, Fast cycle, Precision & copy, Cross-check, Safety gate, Strategy, Deep thinking, High reasoning, Roadmap, Security-critical, Found in material |

## 5. What is next

1. The owner approves or changes the vocabulary in [UI_GLOSSARY.md](UI_GLOSSARY.md).
2. Component passports: one per component in §2, with anatomy, every state, behavior and the reference it follows, starting with the status badge, the list row and the Needs you card.
3. Screen passports, starting with Needs you, Review and the step page.
4. A clickable prototype of those three screens, then acceptance checks AIWorks can build against.

Screenshots and the raw inventory are reproducible: start the synthetic dashboard and run the crawler in the order described above.
