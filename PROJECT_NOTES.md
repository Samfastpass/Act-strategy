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

**Caveat**: numpy/pandas aren't installed on the dev machine, so the
2026-09-09 additions (`vol_target` sizing, `conditional_odds`) and the
2026-09-17 `years` fix are syntax-checked and desk-checked against the JS
but have not been executed. The JS side was verified against independent
from-scratch implementations. Install numpy/pandas and run the Python
before trusting it as a tiebreaker.

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

## S&P Leverage explorer tab
Sweeps the **binary** version of the S&P strategy — in at a fixed leverage,
out to cash, no vol gate — over a grid of SMA lengths (rows) × symmetric
buffers (columns), on `SPX_MERGED`. Controls: period · leverage (1/2/3/5x)
· grid range (broad/zoomed) · colour metric (Calmar default, CAGR
alternative). Clicking a cell opens `js/price-chart.js`: price, its SMA,
the buffer band, and in/out drawn as background colour blocks.

**The finding this tab exists to show**: at 5x binary, *17 of 49* combos
are wiped out by the single −20.5% day of 1987-10-19, and every survivor
still carries a −98% to −99.9% drawdown. At 3x nothing is wiped out. So
what makes the live 5x strategy survivable is **the vol gate**, not the
choice of SMA or buffer — the gate had ratcheted it down before 1987.

Clicking a cell opens two charts: `js/price-chart.js` (price, SMA, buffer band,
in/out blocks) and `js/perf-chart.js` (performance + underwater).

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

Free cross-check: the underwater panel's marked worst point and the matrix
cell's max drawdown are computed by two separate code paths and must agree
(both read −99.8% at 1941-10-16 for the live combo). If they ever diverge, one
of them is broken.

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
