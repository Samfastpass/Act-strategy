# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

There is no build step, package manager, linter, or test suite. This is a
static site: `index.html` plus plain `<script src>` files under `js/` —
no bundler, no dependencies beyond a CDN-loaded `@supabase/supabase-js`.

- **Run locally**: serve the directory with a static file server (e.g.
  `python -m http.server`) and open it. Opening `index.html` directly via
  `file://` will fail — the app `fetch()`s `strategies.json`, which
  browsers block under `file://`.
- **Deploy**: push to the branch GitHub Pages serves from — there is no
  separate build/publish step.

## Architecture

Read [PROJECT_NOTES.md](PROJECT_NOTES.md) first — it documents the
strategies, the Supabase data model, and design principles (e.g. why raw
prices are stored instead of computed signals, why `SPX_MERGED` exists and
must never be treated as raw data, and a 1000-row Supabase pagination
gotcha).

**`strategy_lib.py` is the validated ground-truth reference** for the
backtest/CAGR math (not run by the site — pure Python, checked against
`js/strategy-engine.js` by hand/by test). If `js/strategy-engine.js`'s
behavior ever disagrees with it, treat `strategy_lib.py` as correct and
fix the JS. It's also the intended source to port from when building out
the Strategy Explorer tab.

Both sides now derive CAGR's elapsed time from actual calendar dates.
Never reintroduce a row-count-based year count — rows are observations,
not days, and an equity series has ~252 of them per year (see
PROJECT_NOTES.md).

Key points not to relitigate:

- The Supabase anon/publishable key embedded in `js/supabase-client.js` is
  meant to be public (client-side auth model) — not a leaked secret. The
  Twelve Data API key is the opposite case: it's entered at runtime and
  kept only in `localStorage` (`js/import-tools.js`) — never hardcode it,
  it's a metered personal-account key.
- `prices` is the only Supabase table: `(asset, date, close)`, long
  format, no `strategy_state` table. Any query against it must paginate
  with `.range()` (see `loadAsset` in `js/app.js`) — the project caps
  responses at 1000 rows server-side regardless of requested range size.

**File layout**: `strategies.json` is the single source of truth for
strategy parameters (SMA length, buffer, vol gate, leverage, sizing mode,
which asset each strategy live-tracks vs. backtests against) — both the
Home and Developed-strategies tabs read from it. Home renders only
`active: true` entries; Developed renders all, marking `archived: true`
ones as Shelved. `js/strategy-engine.js` is one generic state-machine
engine (`walk`, `computeStatus`, `backtestEquityCurve`, `cagr`)
parameterized by those entries, supporting two position-sizing modes:
the default `fixedLeverage` (discrete leverage, optionally vol-gated with
a one-way ratchet) and `volTarget` (continuous sizing at
`volTarget/vol` capped at `maxSize`, with a `rebalanceBand` no-trade
band). `state[i]` means exposure in both — a leverage multiple under the
former, a fraction of capital under the latter — so the equity math is
shared. `js/chart.js` (log-scale SVG equity chart) and `js/odds.js`
(conditional outcome distributions) power the Developed tab's detail
panel; see PROJECT_NOTES.md for the statistical caveats baked into the
odds table.
`js/merge-series.js` keeps `SPX_MERGED` in sync (regression-converts new
SPY rows to SPX-equivalent units) whenever `js/import-tools.js` writes new
SPX/SPY data via the Twelve Data fetch or the CSV drop. `js/app.js` is the
bootstrap: loads all price series, wires tab switching, and calls each
tab's `render()`.
