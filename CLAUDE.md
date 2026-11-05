# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ThinCap 140 — an offline, single-file browser app (Ukrainian UI) that a **taxpayer's accountant** uses to compute the differences under art. 140.2–140.3 of the Tax Code of Ukraine (rows 3.1.1 / 3.2.1 of Annex РІ) and print a **бухгалтерська довідка** (the client's own accounting note). Developed by ТОВ АФ «Алекс С. Аудит»; the UI follows the firm's Brand Guide v2.2 (digital channel), the printout deliberately does not use the firm's letterhead (it is the client's document). The app is used year after year (2026, 2027, …) from one data file.

## Commands

Build commands, the case-file format and the versioning rule are in `README.md` («Збирання», «Дані клієнтів», «Версія»): `python3 build.py` builds the demo into `dist/thincap-140.html`; `--case … --out …` builds a client copy into git-ignored `cases/`. `build.py` runs `node --check src/app.js` before building when node is available. The version number lives only in `VERSION` and is injected as `@@VERSION@@`.

There is no test suite or linter. Changes are verified by loading the built HTML in headless Chromium (Playwright is available in the cloud container) and calling page globals (`model()`, `calcPeriod()`, `poolRows()`, `S`) or driving the UI. Block the SheetJS CDN (`page.route(/cdnjs/, r => r.abort())`) to test offline behaviour. When restoring state inside a test, use `S = migrate(JSON.parse(...))`, never a bare `JSON.parse` (see the state model below).

`dist/thincap-140.html` is a committed build artifact: rebuild and commit it together with every change to `src/`. Because every PR touches it, two branches cut from `main` in parallel conflict there. If an earlier PR is still open, cut the new branch from that branch, but still open the PR against `main` (it shows the earlier commits until that PR is merged).

## Build pipeline

`build.py` inlines everything into one HTML file: `src/app.html` contains placeholders `/*@@FONTS@@*/` (base64 woff2 from `vendor/fonts/`, latin + cyrillic subsets), `@@LOGO@@` (SVG from `brand/assets/logo/`), `/*@@APPJS@@*/` (`src/app.js`), `@@VERSION@@` (from `VERSION`, in both files); inside `app.js`, `/*@@CASE@@*/null` is replaced with the case JSON (`--case`, default `src/demo.case.json`). The build asserts no `@@` placeholder survives. The only external dependency is SheetJS from cdnjs for Excel export.

## Architecture of `src/app.js`

**State.** One global `S`, persisted to `localStorage` (`STORE_KEY`), saved/loaded as JSON. Schema 4: `S.years[year] = {periods: {Q1,H1,M9,Y}, active}`, plus `meta`, `method`, `history` (carry-forward rows entered from filed returns), `poolInitial`, `saveInfo`/`changedAt`. `S.periods` and `S.active` are **non-enumerable accessors** for the selected year (`S.meta.year`) installed by `attach()`; they are not serialised. Every assignment to `S` must go through `migrate()` (which upgrades older schemas — single-year `periods`, schema ≤ 3 — fills in a missing `periods`, `active` or `meta.year`, and calls `attach()`); `blankState()` and `exampleState()` already do. `exampleState()` drops `saveInfo`/`changedAt` so a client copy starts as "not saved". When changing the data shape, bump `schema` and extend `migrate()`.

**Engine (pure functions).**
- `calcPeriod(p, meta, method, poolOpening)` — one period: the 3.5× debt/equity test, limited interest (СП) after the art. 140.2 exclusions by creditor category (`CATS`), the limit and the 3.1.1 / 3.2.1 amounts. Which version of art. 140.2 applies is chosen by `regimeOf(meta)` (`REGIMES`: before 2021, the early 2021 tax-authority approach, current).
- `poolRows(Y)` — the carry-forward pool before year `Y`, built year by year. A manual `history` row (from a filed return) takes precedence over a year calculated in the app; rows may carry a documented opening `adj`; `poolInitial` is the 01.01 balance of the first year, already after the 5 % haircut. `runVintages()` is a FIFO breakdown for display only.
- `model()` — current year: opening pool, results of filled periods, pool rows plus the current-year row.
- `filled(p)` decides whether a period is included (any closing balance / interest / ФВ / АВ / ФРО / other differences; carried-over 01.01 balances do not count). The carry-forward uses the **latest filled** period of each year.

**Rendering.** `renderAll()` = period bar + inputs + outputs + pool + params. The `input` handler updates `S` and calls only `renderOutputs()`/`renderPeriodBar()` so the focused field is not re-rendered; `change` triggers `renderAll()`. Control procedures are built inside `renderOutputs()` with levels `err > warn > info > ok` (status always shown as a word, not only colour).

**Printing.** `printWorkingPaper()` fills `#printArea` and toggles `body.wp`; `periodSection()` reuses the rendered calculation trace by temporarily switching `S.active`. Print CSS (`@page`, margin boxes for page numbers) lives in `app.html`.

**Files.** `saveFile()` uses `showSaveFilePicker` (Chrome/Edge; keeps the Cyrillic name), otherwise an `application/octet-stream` download with a transliterated name (`latin()`), because Chrome on `file://` pages drops non-Latin download names. Loading accepts the current format, the legacy single-year format and a case wrapper `{state: …}`. A case file's `rev` makes the app offer to replace older data stored in the browser.

**Formatting.** `fmt()` prints NBSP-grouped numbers with negatives in parentheses; `num()` parses spaces, commas and parentheses. Some source strings contain literal U+00A0 — exact-string edits may need to account for it.

## Rules that matter here

- **The repository is public. Client data never goes into it** — not in code, commits, PR titles/bodies or `dist/` (details in README «Дані клієнтів»). Before committing, grep the tree (excluding `cases/`) for client names and amounts.
- Pull requests always target `main`; the user merges them.
- The app is for the taxpayer: no auditor working-paper wording, ISA references or the firm's letterhead/QR in the printout; the firm's logo appears only in the app UI next to its full name.
- Brand rules (fonts Playfair Display / Manrope / JetBrains Mono, Audit Green palette, contrast ≥ 4.5:1, status never by colour alone) come from the «МІП та АСА» brand guide.
