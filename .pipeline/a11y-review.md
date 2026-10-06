# Accessibility review: Qwixx score sheet

Standard: WCAG 2.2 Level AA, plus the Luwah accessibility playbook.
Scope: `app/` and `components/`, reviewed against `.pipeline/spec.md` section 9.
Date: 2026-09-01.

## VERDICT: BLOCK

Five Level A or AA failures sit on the core user path, the score grid itself. Two of them make the app unusable with a screen reader once any player locks a colour.

The spec's section 9.4 claim is only partly true. The three row-identity cues did ship. The cell and lock state cues did not survive contact with the closed-row and locked states.

There is no published accessibility statement and no third-party embed, so bucket (b) and bucket (c) are both empty. Every finding below is bucket (a), fixable in this repo.

---

## Findings, ordered by user impact

### 1. HIGH. A locked row's lock cell is deleted from the accessibility tree
`components/LockCell.tsx:47-56`

When `state === 'locked'` the component renders `<div aria-hidden="true">` holding the padlock and the word `Locked`. Locking is the single most consequential move in Qwixx. It adds a cross, adds the +1 bonus, and shuts the colour for the whole table. A screen reader user gets total silence where the lock used to be, and cannot afterwards determine that the row is locked or who locked it.

Section 9.4 lists a semantic for every lock state. This one shipped with none.

WCAG 1.3.1 Info and Relationships (A), 4.1.2 Name Role Value (A).
Fix: remove `aria-hidden`, render a disabled `<button aria-pressed="true" aria-label={`Lock ${color}, locked`}>` so the state is announced.

### 2. HIGH. A remote row closure is announced to nobody and destroys keyboard focus
`lib/sync.ts:616`, `components/ScoreRow.tsx:34,43,45,57`

`applyPollResult` assigns `this.lockedRows = res.game.lockedRows` with no toast. `REASON_MESSAGES.row_closed` at `lib/sync.ts:42` only fires when *you* try to cross into a dead row, which is after the fact.

Two failures follow.

(a) Nothing announces the closure. The only new content is the `<p id={describedById}>Closed by {name}</p>` at `ScoreRow.tsx:57`, which sits outside any live region. It is wired via `aria-describedby` on the `<section>` at `ScoreRow.tsx:43`, but that section has no accessible name so Chrome maps it to `generic`. Verified with CDP `Accessibility.getFullAXTree` against the compiled stylesheet: the score grid yields **0 nodes with role `region`**. A description on a nameless generic container is not surfaced by AT.

(b) `ScoreRow.tsx:34` flips `disabled` on every cell in the row. If keyboard focus is sitting on one of those cells when the poll lands, the browser drops focus to `<body>`. The user loses their place with no warning and no announcement.

WCAG 4.1.3 Status Messages (AA), 1.3.1 (A).
Fix: diff `lockedRows` in `applyPollResult` and `setToast` the closure, add `aria-label={`${ROW_LABEL[color]} row`}` to the section so the description resolves, and move focus to the row header before disabling a focused cell.

### 3. HIGH. Closed rows give a false reason in the accessible name
`components/LockCell.tsx:33,38` and `components/NumberCell.tsx:23,29`

`LockCell` branches on `state === 'unavailable' || (disabled && state === 'available')` and both paths emit `aria-label={`Lock ${color}, five crosses needed`}`. When the row was closed by another player the lock is gone entirely, but the name still tells the user to go collect five crosses. A wrong name is worse than a missing one, because the user acts on it.

`NumberCell` has the same shape. Any open cell in a closed row falls into the blocked branch and is named `"Red 5, no longer available"`, the wording reserved for cells left of your rightmost cross. It never says the colour was closed.

WCAG 4.1.2 Name Role Value (A).
Fix: pass the closed reason into both components and branch the label on it.

### 4. HIGH. Closed-row text drops to between 2.57:1 and 3.07:1
`components/ScoreRow.tsx:44`

`opacity-60` is applied to the whole `<section>`, which composites the header ink and the muted direction text over the page canvas `#f8fafc`. Computed with the playbook ratio function:

| Text | Effective fg | Effective bg | Ratio | Need |
|---|---|---|---|---|
| red ink | `#bf7475` | `#fcecec` | **3.07** | 4.5 |
| yellow ink | `#b3926d` | `#fcf6dc` | **2.67** | 4.5 |
| green ink | `#70a184` | `#e7fbef` | **2.73** | 4.5 |
| blue ink | `#758ace` | `#e7f0fd` | **2.91** | 4.5 |
| direction text, all four | `#8e97a4` | tints above | **2.57 to 2.73** | 4.5 |

This is static text inside a container, not an inactive user interface component, so the 1.4.3 exception does not apply. The faded block contains the row name, the direction text and the `Closed by <name>` line. That is precisely the non-colour cue set section 9.4 depends on, and it fades exactly when it matters most.

WCAG 1.4.3 Contrast (Minimum) (AA).
Fix: drop `opacity-60` from the section. Dim only the grid, or add a closed-state ink token that clears 4.5:1 on the tint.

### 5. HIGH. No cell has a 3:1 boundary against the card it sits on
`components/NumberCell.tsx:50`, `components/LockCell.tsx:65`, `components/PenaltyTrack.tsx:30`, `components/TotalBar.tsx:22`, `components/CreateOrJoin.tsx:89,110,124`

`--color-qx-line #cbd5e1` is the only edge on the open number cells, the lock cell, the unfilled penalty boxes, the Undo button and both text inputs. Neither the border nor the fill reaches 3:1:

| Pair | Ratio | Need |
|---|---|---|
| `#cbd5e1` border on `#ffffff` | 1.48 | 3.0 |
| `#cbd5e1` border on `#f8fafc` | 1.42 | 3.0 |
| `#cbd5e1` border on red tint `#fee2e2` | 1.22 | 3.0 |
| `#cbd5e1` border on yellow tint `#fef3c7` | 1.33 | 3.0 |
| `#cbd5e1` border on green tint `#dcfce7` | 1.35 | 3.0 |
| `#cbd5e1` border on blue tint `#dbeafe` | 1.22 | 3.0 |
| white cell fill vs red/blue tint | 1.22 | 3.0 |
| white cell fill vs yellow tint | 1.11 | 3.0 |
| white cell fill vs green tint | 1.10 | 3.0 |
| `#f8fafc` control fill vs `#ffffff` card | 1.05 | 3.0 |

So on the score grid neither the cell's white fill nor its grey border tells a low-vision user where one tap target ends and the next begins. On the entry screen the join-by-code input has no perceivable edge at all.

WCAG 1.4.11 Non-text Contrast (AA).
Fix: darken `--color-qx-line` to about `#64748b`, which clears 3:1 on white, canvas and all four tints. This is a single token change, so every control inherits it.

### 6. MEDIUM. Number cells physically overlap between 359 px and 373 px viewport width
`components/ScoreRow.tsx:62`, `components/NumberCell.tsx:49`, `components/LockCell.tsx:65`

The grid uses `grid-cols-6 gap-1.5`, whose tracks are `minmax(0,1fr)`, but each cell also carries a fixed `w-cell` of 56 px. The fixed width overruns the track and eats the gap. Measured with system Chrome against the compiled stylesheet:

| Viewport | Cell width | Gap between adjacent cells |
|---|---|---|
| 358 px | 44 px | 9.33 px |
| **360 px** | 56 px | **-2.34 px** |
| **366 px** | 56 px | **-1.34 px** |
| **372 px** | 56 px | **-0.34 px** |
| 374 px | 56 px | 0 px |
| 390 px | 56 px | 2.66 px |

360 px is a very common Android CSS width. In the overlap strip the tap lands on whichever cell paints last, so the user crosses the wrong number in an irreversible-feeling game. The intended 6 px gap is never achieved at any width above 359 px.

2.5.8 Target Size is not failed, each target is still 56 px. This is a mis-tap defect on the core path.

Related: the spec's own arithmetic at 9.1 is wrong. It computes from 366 px usable and forgets the card's `border-2` (4 px) plus `p-2` (16 px). Real grid content width at 390 px is 346 px, not 366 px.

Fix: drop `w-cell` and let the track size the cell. Use `w-full h-cell min-w-11`.

### 7. MEDIUM. The game screen has no `h1` and no named landmarks
`components/GameClient.tsx:254-278`, `components/ScoreRow.tsx:43`, `components/Lobby.tsx:25,34`, `components/OpponentList.tsx:16`

The active game screen renders a header, four row cards and a totals bar with no heading of any level. The first heading in the document is `OpponentList.tsx:16` `<h2>Other players</h2>`, so the outline starts at h2.

The lobby has the same shape. `Lobby.tsx:34` is an `<h2>Players</h2>` with no h1 above it, and the join code at `Lobby.tsx:25` is a `text-4xl font-bold` `<p>` doing the job of a page title. The playbook calls this out directly: styled paragraphs that should be headings.

The four row cards are `<section>` with no accessible name, so they produce no landmark either (verified: 0 `region` roles). A screen reader user has no heading and no landmark to reach the yellow row. They arrow through 53 buttons.

WCAG 1.3.1 (A), 2.4.6 Headings and Labels (AA).
Fix: add `aria-label={`${ROW_LABEL[color]} row, ${ROW_DIRECTION[color]}`}` to each ScoreRow section (this also makes finding 2's `aria-describedby` resolve), add an `sr-only` `<h1>Game {code}</h1>` to the active screen, and promote the lobby code to `<h1>`.

### 8. MEDIUM. The New game / Join game toggle signals its state by colour alone
`components/CreateOrJoin.tsx:59-76`

The selected mode is conveyed only by `bg-qx-text text-qx-surface` versus plain text. No `aria-pressed`, no tab pattern, no icon, no text. A screen reader user hears two identical unlabelled-state buttons and cannot tell which form is on screen. This is the exact defect class section 9.4 was written to prevent, sitting on the entry screen where every user starts.

WCAG 1.4.1 Use of Colour (A), 4.1.2 (A).
Fix: `aria-pressed={mode === 'create'}` and `aria-pressed={mode === 'join'}`.

### 9. MEDIUM. Every tap fires three live regions, two of them contextless
`components/ScoreRow.tsx:53`, `components/TotalBar.tsx:16`, `components/SyncStatus.tsx:19`

`ScoreRow.tsx:53` puts `aria-live="polite"` on the bare row score, so all four rows are live regions. `TotalBar.tsx:16` makes the bare total live. `SyncStatus.tsx:19` is `role="status" aria-live="polite"` and cycles `Saving 1` then `Synced` on every single tap.

One cross therefore queues: the button's pressed state, a naked number from the row, a naked number from the total, `Saving 1`, `Synced`. Because both numeric regions contain only the digits, the user hears "23" and "104" with no idea which is which. Section 9.4 asked for one live total, not four row scores plus a sync ticker.

WCAG 4.1.3 (AA), and 1.3.1 (A) for the numbers with no programmatic label.
Fix: remove `aria-live` from `ScoreRow.tsx:53`. Move the label inside the region in TotalBar, `<span aria-live="polite">Total {total}</span>`. Set SyncStatus to `aria-live="off"` and announce only the transition into Offline.

### 10. MEDIUM. The join-code input's accessible name contains the whole alphabet
`components/CreateOrJoin.tsx:102-115`

The hint `<span>Codes use only these characters: 23456789ABCDEFGHJKLMNPQRSTUVWXYZ</span>` is inside the `<label>`, so it becomes part of the input's accessible name. A screen reader reads 32 characters before the user can start typing.

WCAG 4.1.2 (A).
Fix: move the span outside the label, give it an `id`, and reference it with `aria-describedby` on the input.

### 11. MEDIUM. The entry-screen error region is created at the moment it is populated
`components/CreateOrJoin.tsx:137-141`

`role="status"` is on a `<p>` that only renders when `error` is truthy. A live region must already be in the DOM when its content changes, or many AT and browser combinations never fire. `Toast.tsx:18` gets this right, the container is always mounted and only the child swaps. Additionally the error is not associated with either input and focus is not moved, so a screen reader user who tabs back to the field hears nothing about why it failed.

WCAG 4.1.3 (AA), 3.3.1 Error Identification (A).
Fix: render the `<p role="status">` unconditionally with `{error}` inside, and add `aria-describedby` from the failing input.

### 12. MEDIUM. No `autocomplete` on the display-name fields
`components/CreateOrJoin.tsx:83-90` and `:118-125`, `components/GameClient.tsx:182-189`

Display name is user-identifying information covered by the input purpose taxonomy. All three name inputs omit `autocomplete`.

WCAG 1.3.5 Identify Input Purpose (AA).
Fix: `autoComplete="nickname"` on all three.

Separately, and not a WCAG failure: the code input at `CreateOrJoin.tsx:104-111` has no `autoCapitalize`, `autoCorrect`, `spellCheck` or `inputMode`. `handleCodeChange` at line 48 uppercases and filters so the value cannot be corrupted, but iOS predictive text still fights the field. Add `autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" inputMode="text"`.

### 13. MEDIUM. The opponent disclosure has no visual affordance
`components/OpponentList.tsx:22`

`list-none` on the `<summary>` suppresses the marker (preflight keeps `summary{display:list-item}`), and nothing replaces it. No chevron, no plus, no underline. A sighted mouse or touch user has no cue that the strip expands. `Collapsible.tsx:29` does this correctly with a `+`/`−`. The ARIA side is fine, `<details>` exposes expanded natively.

WCAG 1.3.1 borderline, primarily a usability defect.
Fix: add the same `+`/`−` span used in `Collapsible`.

### 14. LOW. Blocked cells fall to ~2.5:1
`components/NumberCell.tsx:28,32`

`opacity-40` over the tint gives red 2.47, yellow 2.52, green 2.52, blue 2.46. These are `disabled` buttons, so 1.4.3 and 1.4.11 formally exempt them as inactive components. Not a failure. But the number identifies which values you have skipped past, which is real game information, and inside a closed row this compounds with finding 4's `opacity-60` to an effective 0.24 alpha. Recommend raising to `opacity-60` on the cell and removing the section-level fade.

### 15. LOW. The skip link does not move focus
`components/SkipLink.tsx:3`, every `<main id="main">`

`href="#main"` targets a `<main>` with no `tabIndex={-1}`. Chrome and Firefox set a sequential focus navigation starting point so the next Tab works, but focus never lands on `main`, so AT does not announce arrival. Add `tabIndex={-1}` to each `<main id="main">`.

### 16. LOW. The mobile floor breaks at 359 px, not 360 px
`components/NumberCell.tsx:28,49`, `components/LockCell.tsx:39,51,65`

`max-[359px]:` compiles to `@media not all and (min-width:359px)`. Measured: 358 px gives 44 px cells, 360 px gives 56 px cells. At exactly 359 px the full-size rule applies. `README.md:125` and spec 9.4 both say 360 px is the floor. Off by one. Use `max-[359.98px]:` or `max-sm:` with a matching breakpoint.

### 17. LOW. The game-over panel is announced twice
`components/GameOver.tsx:19,26`

`role="status"` wraps the whole panel, so on mount AT reads the heading plus every standing plus every row score as one announcement. Line 19 then moves focus to the `<h1>`, which reads the heading again. Prefer `role="status"` on a short sr-only sentence and keep the focus move.

### 18. LOW. No accessibility gate in CI
`package.json`

Scripts are dev, build, start, test, typecheck, lint. There is no `pa11y-ci.json`, no Lighthouse step, and no axe assertion in the vitest suite. The playbook requires both build-time gates before the scan phase. Nothing here will catch a regression on findings 1 through 5.

---

## Scanner triage

`python3 ~/.claude/skills/luwah-security-code-review/scripts/scan.py` returned 0 HIGH, 1 MEDIUM, 1 LOW. Both confirmed by reading the line. Both dismissed.

- `a11y-outline-removed` at `components/GameOver.tsx:33`. **DISMISS.** `focus:outline-none` sits on `<h1 tabIndex={-1}>`, a programmatic focus target that is never in the tab order. 2.4.7 does not apply to it.
- `math-random-token` at `lib/scoring.ts:7`. **DISMISS.** It is a comment forbidding randomness in the pure scoring module, not a token.

---

## Verified clean, do not re-check

**Contrast, passing pairs.** Computed with the playbook ratio function, reuse rather than recompute.

- Row ink on its card tint, need 4.5: red `#991b1b`/`#fee2e2` 6.80, yellow `#854d0e`/`#fef3c7` 6.15, green `#166534`/`#dcfce7` 6.49, blue `#1e40af`/`#dbeafe` 7.15. The yellow row, the flagged risk, passes.
- Direction text `#475569` on the four tints: 6.20, 6.81, 6.90, 6.21.
- Cell number ink on the white cell fill: 8.31, 6.85, 7.13, 8.72.
- Card edge on canvas, need 3.0: `#dc2626` 4.62, `#d97706` 3.04, `#16a34a` 3.15, `#2563eb` 4.94. Yellow is the tightest at 3.04 and holds.
- Neutrals: `#0f172a` on `#ffffff` 17.85 and on `#f8fafc` 17.06. `#475569` on `#ffffff` 7.58 and on `#f8fafc` 7.24. `#b91c1c` on `#f8fafc` 6.18 and on `#fee2e2` 5.30. `#ffffff` on `#0f172a` 17.85.
- Focus ring at 2 px offset sitting on the card tint, need 3.0: 6.80, 6.15, 6.49, 7.15.

**Reflow, WCAG 1.4.10.** Measured in system Chrome. `document.scrollWidth === clientWidth` at 320 px on `/`, `/rules`, `/history`, `/profile`, `/offline`, and on the score-grid harness at 320, 360, 390 and 414. Zero elements extend past the viewport at any width. No horizontal scroll anywhere.

**Target size, WCAG 2.2 2.5.8 (24 px).** Measured: number and lock cells 56x56 at and above 359 px, 44x44 below. Penalty boxes 64x64, shrinking to 61x64 at 320 px. Undo, submits and the lobby start button 48 px min-height. Mode toggles and lobby player rows 44 px. Every interactive element clears 24 px with a wide margin.

**Focus visibility, WCAG 2.4.7 and 2.4.11.** Computed outline measured on five representative controls: all resolve to `2px solid rgb(16,16,16)` at `2px` offset in Chrome. No control suppresses the ring. The only `outline-none` in the codebase is on the non-tabbable GameOver h1. Note for the record: no `outline-*` colour token is set on any `focus-visible` utility except `SkipLink.tsx:5`, so the ring colour is whatever the UA picks. It is visible, but it is undesigned. Setting `focus-visible:outline-qx-text` would make it deterministic across Safari and Firefox.

**Reduced motion, WCAG 2.3.3.** The only two animated components, `NumberCell.tsx:18` and `GameOver.tsx:15`, both gate on `useReducedMotion()` and pass `undefined` for `whileTap`, `animate` and `initial` when reduce is set. Framer Motion is not used anywhere else. The compiled stylesheet contains no `@keyframes` and no active `transition` utility. Clean.

**Keyboard traps.** None. There is no modal, no dialog, no `aria-modal`, no focus-trapping overlay anywhere in `app/` or `components/`. The lobby is a plain screen, not a dialog. The playbook's stacked-overlay Escape protocol and its capture-phase / `defaultPrevented` rules are not applicable to this codebase.

**`Collapsible.tsx`.** Correct disclosure pattern. `aria-expanded` on the button, `aria-controls` pointing at a `panelId` that exists in both open and closed states, `role="region"` with `aria-labelledby` back to the button `id`, and `hidden` toggled rather than unmounted. No dangling reference at any moment.

**`Toast.tsx:18`.** Correct live-region pattern. The `role="status" aria-live="polite"` container is always mounted and only the child swaps.

**Row identity cues, spec 9.4.** All three shipped as specified. Shape glyph at `RowGlyph.tsx:29-57` with `aria-hidden="true"`, circle / triangle / square / diamond matching the table. Text label `ROW_LABEL` and direction text `ROW_DIRECTION` both rendered at `ScoreRow.tsx:47-52`. `ROW_CLASSES` is a lookup object, not a template literal, as section 10 requires.

**Open and crossed cell semantics.** `NumberCell.tsx:44-45` matches the spec strings exactly: `aria-pressed={false}` with `Cross off red 7`, `aria-pressed={true}` with `Red 7, crossed off`. `aria-pressed` is used correctly, both values are truthful, and the crossed state carries a drawn X plus `border-current` in addition to colour.

**Lighthouse.** Accessibility 100 on `/` and `/rules`. No pa11y config exists in the repo. The game screen could not be scanned because Supabase is unreachable in this environment, so findings 1 through 9 come from reading the code and from CDP measurement against a harness built from the components' exact class strings, not from an automated scan.

**Other.** `<html lang="en">` at `app/layout.tsx:20`. Rules table has `<caption>` and `<th scope="col">` at `app/rules/page.tsx:36-45`. No images, no iframes, no third-party embeds, so alt text, captions, iframe titles and click-to-load facades are all not applicable. No accessibility statement page exists, so no public claim has been made false.
