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

## `strategy_lib.py` — ground truth reference
`strategy_lib.py` is a validated Python reference implementation (not run
by the site — Python, no build integration) that `js/strategy-engine.js`
is ported from and must be checked against whenever the two disagree:
`run_backtest` (core engine), `grid_search` (parameter sweeps),
`conditional_forward_return` (episode studies), and `BTC_PARAMS`/
`SPX_PARAMS` (validated settings). It's also the intended foundation for
the Strategy Explorer tab once that's built (`grid_search` is the sweep
behind a heatmap; `conditional_forward_return` is the "what happens from
here" episode study).

**One known, deliberate divergence**: `run_backtest`'s `years` for
CAGR/Sharpe/etc. is `eval_days / 365.25`, where `eval_days` counts array
rows. That's correct for BTC (continuous daily series, `annualization=365`
matches) but wrong for SPX/SPY/SPX_MERGED (trading-day series only,
~252/year) — treating a row count as a calendar-day count understates
elapsed time by roughly 1.45x, which inflates CAGR. Checked empirically on
the real SPX_MERGED series: 24,587 eval rows is 67.3 "years" by that
formula vs. 97.9 actual calendar years. `js/strategy-engine.js`'s `cagr()`
instead computes elapsed time from the actual `date` values, which is
correct for both continuous and trading-day series — kept intentionally
rather than porting the row-count version. Worth fixing in
`strategy_lib.py` too if it's used for real Python-side analysis on
SPX/SPY data, not just BTC.

## The two strategies
1. **Bitcoin**: 40-day SMA, 0% buffer. In whenever price > SMA, out
   whenever price < SMA. No leverage. Because the buffer is 0%, this signal
   has no path-dependency — it's recomputed fresh from the trailing 40 days
   every time, never stored as state.
2. **S&P 500 (tracked via SPY)**: 200-day SMA, 3% buffer (enter above
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

## Where this is headed
The **Strategy explorer** tab exists as a placeholder ("coming soon").
Next planned feature: letting the user define and backtest arbitrary
parameter combinations (different SMA lengths, buffers, vol thresholds)
against the full historical data (`SPX`+`SPY`, or `SPX_MERGED` for a
single continuous view) directly in that tab, reusing
`js/strategy-engine.js`'s generic engine — not just the two fixed
strategies in `strategies.json`. Nothing built yet — this is the next
thing to design.
