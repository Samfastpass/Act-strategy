# Strategy tracker — project notes

## What this is
A live dashboard tracking systematic trading strategies daily, backed by
Supabase, deployed as a static site on GitHub Pages. Still zero build
step — `index.html` plus a handful of plain `<script src>` files under
`js/` (see CLAUDE.md for the file layout). Three tabs:
- **Home** — daily-use view: live status card per `active: true` strategy
  in `strategies.json`, the quick "log today's close" form, and history
  table.
- **Developed strategies** — the same strategies, each with a live status
  card plus CAGR backtested over four windows (all-time/10y/3y/1y), and
  the data-import tools (Twelve Data refresh + CSV drag-and-drop).
- **Strategy explorer** — placeholder, see "Where this is headed" below.

## Strategy config
Strategy parameters (SMA length, buffer, vol gate, leverage, annualization,
which asset each one live-tracks vs. backtests against) live in
`strategies.json`, not hardcoded per-strategy JS. `js/strategy-engine.js`
is one generic parameterized engine (`computeStatus`/`backtestEquityCurve`/
`cagr`) that both strategies run through — replaced the old
hand-duplicated `computeBTC`/`computeSPY` functions. A new strategy is
(mostly) just a new entry in `strategies.json`.

## Charts and odds (Developed tab)
Clicking a strategy card opens a full-width detail panel:
- **Equity chart** (`js/chart.js`) — hand-rolled SVG, no charting library.
  Strategy vs. buy & hold, both rebased to 1× at the window start, with
  selectable 1y/3y/5y/10y/all windows. The y-axis is **log scale**: BTC
  equity spans five orders of magnitude and a linear axis renders the first
  decade as a flat line on the axis.
  Position is shown two ways at once, deliberately: **background colour
  blocks** behind the curves (green at base leverage, amber once the vol
  gate has ratcheted down; for BTC's continuous sizing, one hue at opacity
  proportional to position size) *and* the original **exposure strip**
  whose bar height encodes the same thing. The redundancy is the point —
  green vs. amber is a hard pair for red-green colour blindness, so the
  leverage level must never be carried by colour alone. The legend names
  each level for the same reason. Don't "tidy up" by deleting the strip.
- **Odds table** (`js/odds.js`) — conditional distribution of what happened
  between a given distance-from-SMA and the next flip, bucketed by
  extension band plus a tight ±1pp "now" row.

Two statistical choices worth not undoing:
- The **final episode is excluded** — it hasn't flipped yet, so its outcome
  is unknown; including it would drag every duration and return downward.
- Rows report **both `days` and `eps`**. Consecutive days within one
  episode share the same exit, so they are not independent observations —
  `n=1880 days` can mean as few as a handful of real episodes. Rows backed
  by fewer than 5 episodes are dimmed rather than hidden.

## `strategy_lib.py` — ground truth reference
`strategy_lib.py` is a validated Python reference implementation (not run
by the site — Python, no build integration) that `js/strategy-engine.js`
is ported from and must be checked against whenever the two disagree:
`run_backtest` (core engine, both `size_mode="fixed"` and
`size_mode="vol_target"`), `grid_search` (parameter sweeps),
`conditional_forward_return` and `conditional_odds` (episode studies —
the latter mirrors `js/odds.js`), and `BTC_PARAMS`/`BTC_V2_PARAMS`/
`SPX_PARAMS`. It's also the intended foundation for the Strategy Explorer
tab once that's built.

**Resolved 2026-09-19**: numpy/pandas are now installed and `strategy_lib.py`
has been run for real for the first time — previously every check was
desk-checking against the independently-verified JS, never actual
execution. First run (`SPX_PARAMS`, no costs) reproduced the JS's
independently-verified 18.51% CAGR / −99.84% max drawdown exactly. The
cost model was rebuilt on 2026-09-20 (see "Cost model" below) and re-verified
the same way: JS and Python produce **bit-identical final equity** (relative
difference 0) on the full 98-year S&P history at 1x/2x/3x/5x, with and
without costs. `strategy_lib.product_factor` was written from the prospectus
formula independently of `js/cost-model.js`, so agreement is a real check.
The 2026-09-09 additions
(`vol_target` sizing, `conditional_odds`) are still desk-checked only, not
yet exercised by an actual run — worth doing before trusting them as a
tiebreaker.

**Fixed 2026-09-17 — the row-count year bug.** `run_backtest` used to set
`years = eval_days / 365.25`, where `eval_days` counts array *rows*. Rows
are observations, not calendar days: an equity series has ~252 per year,
so that formula called a 97.9-year SPX_MERGED backtest 67.3 years and
inflated every S&P CAGR by roughly 1.5x:

| window | correct (calendar) | old `rows/365.25` |
|---|---|---|
| all-time | 24.3% | 37.2% |
| 10y | 37.6% | 59.1% |
| 3y | 62.7% | 103.2% |
| 1y | 17.8% | 26.8% |

It hid for so long because BTC trades every calendar day, so ~365
rows/year made the formula accidentally right for the one series anyone
spot-checked. Both `run_backtest` and `js/strategy-engine.js`'s `cagr()`
now derive elapsed time from actual `date` values, which is correct for
continuous and trading-day series alike. Dividing rows by
`annualization` (252/365) is an acceptable fallback; dividing rows by
365.25 is never correct. Don't reintroduce it.

## The strategies
1. **Bitcoin** (live since 2026-09-09): 120-day SMA, 0% buffer, plain
   crossover — in when close > SMA, out when close < SMA. Position size is
   *volatility-targeted* rather than fixed: `60% / annualised 20-day
   realised vol`, capped at 100% of allocated capital, 0% when out. A trade
   only happens when held size differs from target by more than 15
   percentage points (a no-trade band), which works out at roughly 12
   trades/year over the last decade — 13.3/yr measured over 10 years,
   11.2/yr over 5, though 16.1/yr across all history since BTC's early
   years were volatile enough to trigger extra resizes.
   Execution: signal from the BTC 24/7 close, executed next LSE session,
   via WXBT (WisdomTree Physical Bitcoin ETP, 0.15% TER) on Trading 212
   Invest.
   The no-trade band makes this path-dependent — held size carries forward
   day to day, so it can't be evaluated from a single day's close.
2. **Bitcoin 40-day** — *shelved 2026-09-09*, superseded by the above.
   40-day SMA, 0% buffer, no leverage, no sizing overlay. Kept in
   `strategies.json` with `"active": false, "archived": true` so it still
   appears on the Developed tab (marked Shelved) for comparison, but no
   longer shows on Home.
3. **S&P 500 (tracked via SPY)**: 200-day SMA, 3% buffer (enter above
   SMA+3%, exit below SMA-3%), plus a volatility gate — enters at 5x
   leverage only when 20-day realized (annualized) volatility is under 22%;
   latches down to 3x if vol crosses 22% while already invested (one-way
   ratchet, doesn't latch back up to 5x until the next fresh entry). This
   *is* path-dependent, so the current leverage state (0/3/5) is derived by
   walking the entire real SPY price history on every load — not stored
   incrementally — specifically so it can never drift out of sync with the
   raw data. That's a deliberate choice: an earlier version tried
   incremental state and it added fragility for no real benefit once full
   history was available.

## Data model (Supabase)
One table, `prices`, long format: `asset text, date date, close numeric`,
primary key `(asset, date)`. RLS is off (personal single-user tool, no
login system). No `strategy_state` table — see above for why.

**Gotcha found 2026-09-06**: this Supabase project caps every response at
1000 rows server-side (`db.max_rows`), regardless of an explicit
`.range()` size — a plain unpaginated query on BTC (5800+ rows) silently
returned only the *oldest* 1000 rows, so the live site was stuck showing
"as of 2013-04-12" instead of the actual latest date. `js/app.js`
(`loadAsset`) now pages through with `.range()` in a loop until a page
comes back short. Any new query against `prices` needs the same
pagination — don't add an unpaginated `.select()` on this table.

## Twelve Data API key
Entered at runtime into a field on the Developed strategies tab and kept
only in the browser's `localStorage` (`js/import-tools.js`) — never
hardcoded or committed. Unlike the Supabase anon key, it's tied to a
metered personal account, so it must never be public.

Four `asset` values currently loaded:
- `BTC` — real daily closes, 2010-07-18 onward, continuous, sourced from
  CoinMetrics (historical bulk) and Twelve Data (recent, filled in as the
  tracker gets used).
- `SPX` — the real S&P 500 index, 1927-12-30 to 2019-12-23. Frozen there —
  useful for long-run historical parameter research, not for live status.
- `SPY` — the real ETF, 1993-01-29 onward, continuous, the series the live
  tracker actually reads for the S&P panel.
- `SPX_MERGED` — a derived, clearly-labeled convenience series: real SPX
  where it exists, real SPY converted to SPX-equivalent units elsewhere
  (calibrated via regression across the 27-year real overlap, not a single
  fixed ratio). Built for research spanning the full 1927-today range in
  one consistent unit. Never treat this as raw data — it has an explicit
  conversion baked in.

## Design principles worth preserving
- **Store raw prices, not computed signals**, wherever the signal has no
  path-dependency (see BTC above) — recompute fresh, don't trust stale
  derived state.
- **Keep honest and derived data separate.** `SPX`/`SPY` are untouched raw
  data. `SPX_MERGED` is clearly named as a derived product. Don't quietly
  convert or overwrite a raw series.
- The Supabase anon/publishable key embedded in `js/supabase-client.js` is
  meant to be public — that's how Supabase's client-side auth model works.
  Don't treat it as a secret needing removal.
- **Leverage in the backtest scales the daily *simple* return, not the
  price ratio raised to a power.** A daily-rebalanced Nx position earns
  `N × (closes[i]/closes[i-1] - 1)` that day; compounding `(price
  ratio)^N` instead (equivalent to raising the *cumulative* return to the
  Nth power) looks similar for a single day but wildly overstates
  multi-year results — caught 2026-09-07 when the S&P strategy's CAGR
  came out ~35-90% instead of the correct ~24-67%. See
  `backtestEquityCurve` in `js/strategy-engine.js`.

## Strategy Explorer tab (formerly "S&P Leverage explorer")
Renamed 2026-09-20 (it has covered five assets and two sizing modes for a
while). It sweeps a trend strategy over a grid of SMA lengths (rows) ×
symmetric buffers (columns), across **five assets**: S&P 500 (`SPX_MERGED`),
Bitcoin (`BTC`), Gold (`GOLD`), Nasdaq 100 (`NASDAQ100`), FTSE 100
(`FTSE100`). Sweep settings: asset · period · grid range · colour metric ·
slippage tier. The strategy itself is the parameter bar (below). Under the
matrices: `js/price-chart.js` (price, its SMA, the buffer band, in/out as
background blocks), `js/perf-chart.js`'s performance/underwater chart and a
gross-to-net cost breakdown — all for the *current strategy*; then the costs
panel (with the fee headline and history chart) and a Data section.

### Design space: one current strategy, up to three linked matrices (2026-09-20)
The tab used to be a single hardcoded SMA × buffer grid. It is now a design-
space explorer built on one idea: **`state.params` is the one current
strategy** — SMA, buffer, start leverage, drop-to leverage, **below-SMA leverage**,
vol window, vol gate, latch — edited in the *Current strategy* bar (plus a Fixed / Vol-gated
sizing switch and a "Reset to live strategy" button, S&P only). Each of up to
three matrices has its own **X and Y axis chosen from those eight parameters**;
every parameter a matrix does *not* vary is read from the bar. **Clicking a
cell writes its two values into the bar**, so the other matrices, the summary
tiles, the price/performance charts and the costs panel all move to that
strategy — that is how a selection in one matrix updates the others. Defaults:
Matrix 1 = SMA × buffer, Matrix 2 = start leverage × drop-to; "+ Add matrix"
gives vol gate × vol window, then anything.
- **Any parameter pair works** (SMA × gate, latch × vol window, ...). Picking
  the other axis's parameter swaps the two. Picking a vol-gate parameter
  switches sizing to vol-gated; switching back to fixed leaves those matrices
  showing a one-click "Switch to vol-gated" message rather than wrong numbers.
- **Below the SMA (added 2026-09-20).** The strategy used to go to cash when out.
  `out` is the exposure held while OUT — cash (0, the default and the original
  behaviour), 1×, 2× or 3× — so "5× max, 3× above, 1× below" is start 5×, drop-to
  3×, below 1×. It is not a new signal: the walk is untouched and still says
  in/out; `StrategyEngine.exposureAt` returns `wk.out` whenever the walk is out,
  and the walk's cached result is shared (the tier is layered on a shallow
  copy). "Out" includes both *below the lower band* and *above the upper band
  but waiting for vol to calm*, so the tier also covers the vol-gate wait.
  Rules: it must be strictly below the lowest leverage held above the SMA
  (drop-to if gated, else the single leverage) or the cell is "—" with a
  tooltip; the exposure goes through the same product ladder (1× = the
  unleveraged tracker's fee, 2× = the 3× product), and a change of exposure
  pays slippage. "Round trips" still counts flips of the trend signal, so a
  strategy that holds 1× below the SMA reports its round trips rather than 0.
  Python: `run_backtest(out_leverage=...)`, also covered by
  `tools/check_js_vs_python.py` (54 configs, 10 of them with a below-SMA tier,
  zero difference). All-time S&P, net of costs, live 200d/3% 5→3 latched:
  cash below +18.6% / −88.8%; **1× below +19.5% / −89.9%**; 2× below +15.1% /
  −98.9%. Fixed 5×: cash +12.5% / −99.8%, 1× below +13.4% / −99.9%. So 1× below
  adds about a point of CAGR for a slightly deeper drawdown (the 1× leg is
  exposed to the crashes that happen below the SMA), and 2× below is destructive.
  An observation on one price path, not a recommendation.
- **Off-grid values are legal.** Type SMA 210 into the bar and 210d is spliced
  into every SMA axis so "where am I" stays visible. Free-form fields (SMA,
  buffer, vol window, gate) validate and snap back on junk.
- **Invalid combinations are shown, not hidden**: drop-to ≥ start leverage,
  gating at 1×, or leverage with no real product render as "—" cells with a
  tooltip saying why (start leverage / drop-to gives a triangle of them).
- The rings: `is-sel` marks the current strategy's cell in each matrix;
  `is-live` marks a cell only if it matches the live strategy on every
  parameter the current sizing mode uses.
- Every cell is a full parameter set run through the same `walkFor` +
  `windowStats` path as before, and results are cached per (series, period,
  costs, parameters) so re-rendering after a click only recomputes cells whose
  parameters actually changed. Verified against the independent Python
  research engine to the printed digit: live 5→3 = +18.6% / −88.8%, 5→1 =
  +17.1% / −88.8%, 250d/4% 5→1 (zoomed grid) = +15.3% / −89.4%.
- The Broad/Zoomed toggle now applies to every numeric axis that has a fine
  grid (SMA, buffer, gate).

### Sizing: fixed leverage vs vol-gated (added 2026-09-20)
- **Fixed leverage** — in at L, out to cash. The original mode.
- **Vol-gated** — enter at the *high* leverage only while realised vol is
  below a gate; when vol reaches the gate, drop to a *lower* leverage.
  Controls: **latch** (latched / unlatched), **vol window** (10/20/30/60
  days), **gate** (per-asset presets), **down to** (any leverage below the
  high). Defaults are the live S&P strategy's: 20d, 22%, 5×→3×, latched.
  - **Latched** (default) is the one-way ratchet the live strategy uses:
    once vol has spiked, stay at the lower leverage until the position
    *exits* and re-enters fresh. **Unlatched** re-evaluates every day:
    lower leverage whenever vol ≥ gate, back to the high leverage when it
    falls below. The entry rule is the same in both: no entry while vol ≥
    gate (it waits, out of the market).
  - It is not new logic: it is the engine's existing `fixedLeverage` walk
    with `volGate` set, plus a `latch` parameter (`params.latch`, default
    true; Python `run_backtest(latch=True)`). Because the state now moves
    between two *non-zero* levels, gated walks are done at the real
    leverages and the walk's `state` is used directly as exposure
    (`StrategyEngine.exposureAt`); binary walks are still done once at 1×
    and scaled. Every change of leverage is a trade and pays slippage.
  - Vol is annualised sample stdev of daily log returns; the 252-day
    annualisation is used for every asset (Bitcoin has nothing to gate).
    `StrategyEngine.realizedVol` computes it once per (asset, window) and
    every matrix cell's walk shares it via `params.volSeries`.
  - Sanity anchor: gated S&P, 200d/3%, 20d/22%, 5×→3×, latched, *no costs,
    price-only* gives 24.3% CAGR and −87.5% max drawdown in the UI, matching
    the figures verified for the live strategy long before this mode existed.
  - Gate presets other than S&P's 22% are round numbers around each asset's
    typical vol, NOT tuned. The 2× product is held via the 3× (see Cost model).
  - Price chart: full-height green = at the high leverage, half-height amber
    = latched to the lower one (height as well as colour, per the project's
    colour-blindness rule).
  - Observed on the S&P (with costs, 200d/3%): latching matters a lot —
    latched finished ~4x above unlatched over the full history, because the
    ratchet stays defensive through post-crash rallies. Treat as a finding to
    investigate, not a conclusion.

### Fees: headline and history (js/fee-chart.js)
The costs panel opens with tiles — all-in cost **now** (at the latest Fed
Funds/SONIA month), its fee and financing parts, the average over the
selected period and the peak month — and a chart of the approximated all-in
annual cost by month (fees flat, financing following the rate), with dividends
received (yield × leverage) as a dashed line and, for a vol-gated strategy, the
lower leverage's cost as a second line. It uses `CostModel.annualDrag` on the
same product fields and reference series the backtest uses, so it cannot
disagree with the matrix, and it redraws when a field is edited. The platform-
quoted "ongoing charge" (fee + swap × 360) is shown next to the true all-in
figure because the gap between them is the financing (~17%/yr at 5× today).
Months before the rate series begins (before 1954 for Fed Funds) are shaded
and labelled "rate held at … level" — a flat stretch there is not data.

### Data section (auto import)
The explorer tab has a "Data — auto import" panel: a per-asset table (rows,
first/latest date, days behind) plus the same Twelve Data refresh as the
Developed tab (`ImportTools.refreshPanelHTML()`; the CSV drop stays
Developed-only — `wireUp` wires whichever panel is present). It is mounted
in its own container (`#exp-data`), separate from `#exp-main`, so a
half-finished import preview survives clicking around the explorer. The key
stays in this browser's localStorage as before. Reference data (fees,
rates, dividends) is static and is not touched by it.

### Performance / caches
`compoundEquity` was the hot spot (a 7×7 matrix is 49 curves over ~25,000
rows): it now takes day numbers from a per-series cache (`dayNumbers`, a
WeakMap) instead of parsing two date strings per row, and calls the
allocation-free `CostModel.dailyGrowth`. Walk and vol caches are keyed on the
series length and last date, so importing new days can no longer serve walks
one row short (a latent bug in the earlier `asset|sma|buffer` key).

**The finding this tab exists to show**: at 5x binary, *17 of 49* combos
are wiped out by the single −20.5% day of 1987-10-19, and every survivor
still carries a −98% to −99.9% drawdown. At 3x nothing is wiped out. So
what makes the live 5x strategy survivable is **the vol gate**, not the
choice of SMA or buffer — the gate had ratcheted it down before 1987.

`js/perf-chart.js` stacks a mode-switchable top plot over an always-present
**underwater panel** (`equity/runningPeak − 1`, filled downward, deepest point
marked). The underwater panel is the reason the chart exists: "max drawdown
−99.8%" gives the depth but hides the *duration*, and duration is the real cost
— the live 200d/3% at 5x took **17.2 years** to regain its 1941 peak. The top
plot toggles between total return (log, vs unleveraged buy & hold) and three
annualised views: calendar-year bars, trailing 10-year annualised, and
expanding CAGR since the window start.

Two things that must not regress:
- **Ruin on a log axis.** Zero equity has no position on it. The curve is
  clamped to the axis floor after a wipeout and the event marked with a dashed
  rule, rather than emitting `-Infinity` path coordinates. Underwater pins to
  −100%; annualised views return −100% rather than `NaN`.
- **Partial calendar years** at the window edges are shown as the actual
  part-year return and labelled partial, never annualised into a stub figure.

**2026-09-19 consolidation**: the matrix, the performance chart, and the
Developed tab's equity chart used to each carry their own inline
equity-compounding loop (three copies of "leverage × return, minus costs,
floored at ruin"). That duplication is exactly the shape of bug that let the
leverage fix (above) land in one place and not the others, so all three now
call one shared core, `StrategyEngine.compoundEquity` — see below. The
cross-check role that duplication used to serve (two independent
implementations agreeing) is now served by `strategy_lib.py`, which is
executed for real, not desk-checked (see the ground-truth section below).

## Cost model (rebuilt 2026-09-20)
**Read this section before touching costs.** The first version of this model
(shipped only on an unmerged branch) was wrong, and the way it was wrong is
worth remembering: it read a fee off a factsheet, treated WisdomTree's daily
swap rate as a per-unit-of-leverage spread, and left out the Fed Funds
financing leg and the dividends. The user challenged it three times and then
supplied the Final Terms, which settled it. Never again state a leveraged
product's cost from a factsheet figure — derive it from the prospectus
formula and test it against the product's real price history.

### The formula (`js/cost-model.js`, ~30 lines, deliberately standalone)
From WisdomTree's Collateralised ETP Securities base prospectus (p.72, p.199):

    P(t) = P(t-1) x (1 + R) x (1 - CA)
    R    = L x [total return] - (L-1) x (base rate + funding spread) x D/360
    CA   = mgmt fee x D/360 + daily swap rate x D

`D` is calendar days since the previous row (see below). "Total return"
means price return + dividend yield x D/365.25 — the products track total
return, but the explorer's S&P series (`SPX_MERGED`) is a price index, so the
yield (`SPXDIV` in `reference-rates.json`) is added back and multiplied by
leverage. This is why the explorer's S&P numbers are now higher at 1x than
the Developed tab's price-only ones; that is intended, not a bug.

Two products, one expression:
- **3USL** (index = S&P 500 *Net Total Return*): Fed Funds + a 1.245%
  Funding Spread on the borrowed (L-1) units.
- **5USL** (index = S&P 500 Futures *Excess* return, Funding Spread N/A):
  the excess-return index has already netted one unit of Fed Funds and the
  stock-borrow leg adds it back, leaving 5 x TR - 4 x Fed Funds - fees — the
  same expression with spread 0. Its big flat swap rate (0.01736%/day =
  6.34%/yr) is a per-product negotiated fee, NOT scaled by leverage; AJ Bell's
  6.95% "ongoing charge" is 0.70 + 0.01736 x 360 and excludes the variable
  Fed Funds leg, which is why platform figures make 5x look far cheaper than
  it is (~24%/yr all-in at Fed Funds 3.64%).

### `cost-assumptions.json`
Per asset, a list of the **real products at each leverage** (1x tracker, 3x,
5x), with fields named after the Final Terms (`mgmtFeePct`,
`dailySwapRatePct` — note *per day* —, `fundingSpreadPct`) plus `basisPct`
(an empirical allowance NOT in any Final Terms). Each field has a
confidence: `sourced` (printed in a named document), `fitted` (estimated by
matching real prices, method stated) or `assumed`. An exposure is held via
the smallest product with leverage >= it (2x uses the 3x product — the
conservative choice, since no smaller one exists). Only S&P 3x/5x have Final
Terms; Gold/Nasdaq/FTSE 3x products are marked `assumed`/`fitted` until
their Final Terms are checked.

### Reference data (`reference-rates.json`)
Monthly Fed Funds (FRED DFF), SONIA (Bank of England) and S&P dividend yield
(multpl.com / Shiller), built by `python tools/build_reference_data.py`.
Static and versioned rather than Supabase rows (the earlier plan) — nothing
to import by hand, and every point traces to a URL. The site applies a
month's value to every day in it and holds the first/last value outside the
range. Regenerate occasionally; Fed Funds moved on 2026-09-17.

### How it was checked against reality (`python tools/check_leveraged_products.py`)
Drift = (real - model) growth per year; negative means the model is too
generous.
- **3USL, Final Terms fields, 13.8 years: +0.3%/yr** (36.5x real vs 35.6x
  model). Dropping the 1.245% spread gives -2.2%/yr.
- **5USL, Final Terms literally, 2.3 years: about -3.5% to -4.0%/yr** (2.24x
  real vs 2.45-2.50x). Dropping financing entirely gives 1.3-3.8x vs 2.24x,
  so the financing leg is unmistakably real. Precision here is limited: the
  LSE closes ~11:30 ET (before the US close), ~half the days are indicative
  zero-volume prices, and there are only 2.3 years.
- **US-listed SPXL/UPRO/SSO (close with the index, no timing noise), 17
  years:** slope on S&P TR 2.98/3.00/1.99 (R2 >0.994); drift -1.3/-1.2/-0.6%/yr,
  i.e. ~0.6% per borrowed unit above Fed Funds. That is the source of the
  `basisPct: 0.6` allowance on the 5x product (its futures-based index
  finances above Fed Funds); 0.6 x 4 = 2.4% of the ~3.5-4% 5USL gap. Set it to
  0 in the UI for the documents-literal model. Their expense ratios in that
  script are typed from memory, not sourced.
- Yahoo's London 3x series contain an unadjusted 1-for-20 consolidation and
  (3USL, 2017-06-26/27) a bad print; the script splices them out.
  Genuine daily moves are large (5USL moved +37.6% and -30.7% on real days
  in April 2025), so any "jump" filter must key on near-*exact* split ratios,
  not size — an earlier version of the script got this wrong.

### Other facts worth keeping
- The 10% *Restrike Threshold* in the 5USL Final Terms (an index fall of
  10% from the prior close triggers an intraday rebalance to the worst level)
  was not triggered in the 5USL sample (worst daily S&P close-to-close fall
  -6.0%; intraday lows not checked). The explorer does not model it; at 5x a
  10% index fall is already -50%, so the ruin floor dominates. 3USL's is 20%.
- Bitcoin has no leveraged retail product (Leverage Shares BTC3 is
  professional-investors-only): a regulatory wall, not a missing product.
- Historical caveat: the explorer applies today's products' costs across
  history (5x S&P back to 1928). Those products did not exist; this is the
  cost of holding that leverage *today*, applied backwards.

### Slippage, accrual and ruin (unchanged in design)
- **Slippage** — a one-off cost split across each leg, charged whenever
  exposure changes; not a daily drag and not scaled by the size of the
  change. Tiers (low/medium/high) are `assumed` — no measured spreads found.
- **Costs accrue by calendar days elapsed since the previous row, not once
  per row.** Annual rates compound over a calendar year; an equity-index
  asset has ~252 rows/year, so charging per row under-charges to ~69% of the
  stated cost — the same bug class as the CAGR row-count fix above (caught
  by the user asking exactly this before it shipped). Verified: a weekday-only
  260-row asset and a 365-row asset both accrue ~9.4% on a 10%/yr fee, and a
  Monday factor is 3.0008x a single weekday's in log space. A no-op for BTC.
- **Ruin gets closer with costs, never further** — a synthetic knife-edge
  -19.999% day at 5x survives at zero cost and is ruined once ongoing costs
  are added. In real history this is essentially undetectable (the moves
  that ruin a 5x fund are ~20% single-day crashes), which is why the
  synthetic test exists.

## New assets: Gold, Nasdaq 100, FTSE 100 (and their limits)
Sourced via Twelve Data, same refresh mechanism as BTC/SPY
(`js/import-tools.js`'s `TWELVEDATA_SYMBOLS`), with a paginated backfill for
a brand-new asset's first-ever fetch (Twelve Data's free tier caps a single
request at ~5000 points / ~19 years). Symbols were confirmed against
Twelve Data's own `/symbol_search` before wiring anything, not guessed:
- **Gold** → `XAU/USD` (spot).
- **Nasdaq 100** → `QQQ` (Invesco QQQ Trust, NASDAQ) — a **liquid ETF
  proxy**, not the raw multi-decade index, so history only reaches back to
  the ETF's 1999 inception. Materially shorter than `SPX_MERGED`'s 1928+.
- **FTSE 100** → `S100` (Invesco FTSE 100 UCITS ETF, LSE) — same caveat,
  ETF inception (~2011), not the raw index.
This mirrors the project's existing convention (SPY, not raw SPX, is what
the live S&P strategy actually reads) rather than being a new pattern.

Implementation notes worth keeping:
- The binary strategy is not new logic — it's the engine's `fixedLeverage`
  mode with `volGate: null`. `StrategyEngine.walk` is reused as-is.
- The walk is cached per `sma|buffer` **at 1x**, because for a binary
  strategy the in/out *timing* doesn't depend on leverage; leverage is
  applied when compounding. One set of walks serves all four leverages.
- Each period is compounded **fresh from its own start**, so RUINED means
  wiped out *inside* the selected window. Inheriting the full-history
  equity level instead would make every post-1987 window unevaluable
  (0/0) for combos that blew up, defeating the point of a period
  selector. The in/out state still carries in, so there's no artificial
  trade on day one. For combos that never blew up the two are identical.
- Heatmap colour is **blue/red diverging, not the site's usual
  green/red**: the fill is the primary encoding here and red-green is the
  worst pairing for the commonest colour blindness. Every ramp step was
  contrast-checked to keep each cell's printed numbers ≥4.5:1 against
  `--ink` (dark mode's brightest blue had to be darkened from `#2a78d6`
  to `#256abf` to clear it). Ruined cells are hatched and sit outside the
  ramp so they can't stretch the scale.

## Ruin is modelled, in both implementations
`backtestEquityCurve` (JS) and `run_backtest` (Python) both floor equity at
zero when a daily factor goes non-positive, and report `ruinedAt` /
`ruined_at`. Ruin is absorbing — the fund closes, it cannot go negative and
later recover. This fires for no live strategy (their worst-ever daily
factor is 0.601), so it changed no existing number; it exists because the
explorer's high-leverage sweeps hit it constantly.

## Where this is headed
The gated (5x→3x vol-ratchet) version of the leverage explorer is the next
addition, to quantify the gate's contribution directly.
Next planned feature: letting the user define and backtest arbitrary
parameter combinations (different SMA lengths, buffers, vol thresholds)
against the full historical data (`SPX`+`SPY`, or `SPX_MERGED` for a
single continuous view) directly in that tab, reusing
`js/strategy-engine.js`'s generic engine — not just the two fixed
strategies in `strategies.json`. Nothing built yet — this is the next
thing to design.
