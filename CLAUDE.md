# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The site itself has no build step, package manager, linter, or test suite:
`index.html` plus plain `<script src>` files under `js/` — no bundler, no
dependencies beyond a CDN-loaded `@supabase/supabase-js`.

- **Run locally**: serve the directory with a static file server (e.g.
  `python -m http.server`) and open it. Opening `index.html` directly via
  `file://` will fail — the app `fetch()`s `strategies.json`,
  `cost-assumptions.json` and `reference-rates.json`, which browsers block
  under `file://`.
- **Deploy**: push to the branch GitHub Pages serves from — there is no
  separate build/publish step.
- **`tools/`** (dev only, need numpy + internet): `build_reference_data.py`
  regenerates `reference-rates.json`; `check_leveraged_products.py` re-tests
  the cost formula against real leveraged-product prices;
  `check_js_vs_python.py` (also needs Node) runs the site's real JS engine
  and `strategy_lib.py` on 44 configurations of 98 years of S&P data and
  requires them to agree to 1e-9 — run it after touching either engine.
- **`strategy_lib.py`** (the ground-truth reference, below) needs
  `numpy`/`pandas` — installed on this machine as of 2026-09-19
  (`python -m pip install --user numpy pandas`). Run it directly, e.g.
  `python -c "import strategy_lib as sl; ..."`, to check it before trusting
  it as a tiebreaker against the JS.

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
odds table. `js/explorer.js` is the Strategy Explorer (formerly the S&P Leverage
explorer) — a design-space explorer: ONE current strategy (`state.params`,
edited in a parameter bar, incl. the leverage held BELOW the SMA — cash by
default — via `StrategyEngine.exposureAt`'s `wk.out`) and up to three matrices
whose X/Y axes are any two of its parameters, linked because clicking a cell writes back into
`state.params` — across five assets (S&P 500 via
`SPX_MERGED`, `BTC`, `GOLD`, `NASDAQ100`, `FTSE100`) in two sizing modes,
fixed leverage or vol-gated (latched or unlatched; the walk is the engine's
existing `fixedLeverage` mode plus `params.latch`) — with `js/price-chart.js`
for its price/SMA/band/in-out detail chart, `js/perf-chart.js` for its
performance + underwater chart, and `js/fee-chart.js` for the fee headline
and history chart. It also mounts the Twelve Data refresh (`ImportTools.
refreshPanelHTML`) in its own `#exp-data` container. PROJECT_NOTES.md records its caching, per-period
compounding, ruin-on-a-log-axis, and cost-model decisions, which are
load-bearing rather than incidental.

**Costs** — three files, each with one job. `js/cost-model.js` is the ~30-line
formula (WisdomTree prospectus: `P = P_prev x (1+R) x (1-CA)`, R = L x total
return - (L-1) x (base rate + funding spread) x D/360, CA = mgmt fee x D/360 +
daily swap rate x D); nothing else in the app computes a fee or a financing
cost. `cost-assumptions.json` holds the inputs: per asset, the real products
held at each leverage, with Final-Terms-named fields and a
`sourced`/`fitted`/`assumed` flag on every figure. `reference-rates.json`
holds monthly Fed Funds, SONIA and S&P dividend yield, built by
`tools/build_reference_data.py` (never hand-edit). Never hardcode a cost
number elsewhere. `StrategyEngine.compoundEquity` is the **one** shared
equity-compounding core — the matrix, the performance chart, and
`backtestEquityCurve` all call it; if you're tempted to inline a quick equity
loop, extend `compoundEquity` instead. It feeds `CostModel.dailyFactor` and
adds a price-only series' dividend yield back.

Costs accrue by **calendar days elapsed since the previous row**, not once
per row (same bug class as the CAGR row-count fix — see PROJECT_NOTES.md).
`strategy_lib.py`'s `run_backtest`/`product_factor` is an independent
implementation of the same formula; JS and Python agree bit-for-bit.

**Do not state a leveraged product's cost from a factsheet number.** The first
cost model here did exactly that and was wrong (it missed the Fed Funds
financing leg and dividends, and misread the daily swap rate). Derive from the
Final Terms, and test with `python tools/check_leveraged_products.py`, which
re-fits the formula to real 3USL/5USL/SPXL/UPRO/SSO prices. PROJECT_NOTES.md's
"Cost model" section has the results and what they can't resolve.

`js/strategy-config.js` is **what a strategy is**, shared by the Strategy
Explorer and the Evaluator: the parameter registry, validity rules (`resolve`),
the walk and its caches, `windowStats`, the cost config, the saved-strategy
list (localStorage, this browser only), and the session settings both tabs must
agree on (slippage tier, fee edits). Score a strategy through
`StrategyConfig.evaluate` — never reimplement the pipeline in a tab.
`js/evaluator.js` is the Evaluator tab: saved strategies scored across five
fixed decades plus three longer spans, with a buy & hold benchmark row.

Two rules that came from real bugs there: **cache keys identify what a thing
is, never its index in some list** (period 0 means "All" on one tab and "2020s"
on the other — keying on the index served one tab's numbers to the other), and
**a tab that reads shared session state re-renders when shown**, because
`switchTab` only toggles `display`.

Position/leverage is encoded **twice** on every chart that shows it —
colour plus bar height or an explicit label — because green vs amber is a
hard pair for red-green colour blindness. Don't collapse it to one.

Both engines model **ruin**: equity floors at zero when a daily factor
goes non-positive (a >1/leverage loss, or now also enough ongoing cost at
the margin, closes the fund) and it is absorbing. Never remove the floor
to "simplify" — without it a high-leverage sweep silently produces
sign-flipped nonsense.
`js/merge-series.js` keeps `SPX_MERGED` in sync (regression-converts new
SPY rows to SPX-equivalent units) whenever `js/import-tools.js` writes new
SPX/SPY data via the Twelve Data fetch or the CSV drop. `js/app.js` is the
bootstrap: loads all price series (including `GOLD`/`NASDAQ100`/`FTSE100`)
plus `cost-assumptions.json` and `reference-rates.json`, wires tab
switching, and calls each tab's `render()`.
