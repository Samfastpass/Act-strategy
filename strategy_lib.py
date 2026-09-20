"""
strategy_lib.py

Core backtesting engine for the SMA + buffer (optionally vol-gated leverage)
trend-following strategies developed in this project. This is the actual
logic behind every number quoted in the analysis — refactored into reusable
functions rather than one-off scripts, so the strategy-creator feature can
call the same tested code instead of reimplementing it from scratch.

Two validated configurations:
  - Bitcoin:  sma_n=40,  buffer=0.00, annualization=365 (trades every calendar day)
  - S&P 500:  sma_n=200, buffer=0.03, annualization=252, vol_n=20, vol_gate=0.22,
              leverage_high=5, leverage_low=3

No third-party dependencies beyond numpy and pandas.
"""

import numpy as np
import pandas as pd


def compute_sma(closes, n):
    """Rolling simple moving average over n periods. NaN until n-1 index."""
    return pd.Series(closes).rolling(n).mean().values


def realized_vol(closes, n, annualization=252):
    """
    Annualized realized volatility from n trailing daily log returns.
    Output is aligned to `closes` (same length), NaN for the first n indices.
    """
    closes = np.asarray(closes, dtype=float)
    log_ret = np.full(len(closes), np.nan)
    log_ret[1:] = np.log(closes[1:] / closes[:-1])
    vol = pd.Series(log_ret).rolling(n).std(ddof=1).values * np.sqrt(annualization)
    return vol


def _monthly(series, month):
    """Value for 'YYYY-MM' in a {month: value} dict, holding the first/last
    value outside its range (mirrors refSeriesFn in js/explorer.js)."""
    if month in series:
        return series[month]
    keys = sorted(series)
    return series[keys[0]] if month < keys[0] else series[keys[-1]]


def pick_product(products, exposure):
    """The smallest listed product with leverage >= exposure, else the largest."""
    if not products:
        return None
    for p in sorted(products, key=lambda p: p["leverage"]):
        if exposure <= p["leverage"] + 1e-9:
            return p
    return max(products, key=lambda p: p["leverage"])


def product_factor(exposure, total_return, days, base_rate_pct, product):
    """One day's growth factor for a leveraged product, straight from the
    WisdomTree prospectus formula (see run_backtest's docstring)."""
    p = product or {}
    financing = max(0.0, exposure - 1.0) * (base_rate_pct + p.get("funding_spread_pct", 0.0)) / 100.0 * days / 360.0
    r = exposure * total_return - financing
    ca = (p.get("mgmt_fee_pct", 0.0) / 100.0 * days / 360.0
          + p.get("daily_swap_rate_pct", 0.0) / 100.0 * days) * min(exposure, 1.0)
    return (1.0 + r) * (1.0 - ca)


def load_reference_series(path, name):
    """{'YYYY-MM': value} for a series in reference-rates.json (FEDFUNDS,
    SONIA or SPXDIV)."""
    import json
    with open(path, encoding="utf-8") as f:
        return {m: v for m, v in json.load(f)[name]["series"]}


def run_backtest(dates, closes, sma_n, buffer,
                  vol_n=None, vol_gate=None, leverage_high=1.0, leverage_low=1.0,
                  annualization=252,
                  size_mode="fixed", vol_target=None, max_size=1.0,
                  rebalance_band=0.0,
                  products=None, rate_monthly=None, dividend_monthly=None,
                  slippage_bps_round_trip=0.0, latch=True):
    """
    Run the SMA + buffer trend filter, with an optional volatility overlay
    that either gates leverage or sets position size, over a full price series.

    Signal (always present):
        upper = SMA * (1 + buffer); lower = SMA * (1 - buffer)
        OUT -> IN  when close crosses above upper
        IN  -> OUT when close crosses below lower
        (buffer=0 collapses this to a pure crossover with no hysteresis)

    size_mode="fixed" — leverage overlay (only if vol_gate is not None):
        On entry: leverage_high if realized vol < vol_gate, else stay out.
        While invested: if vol rises to >= vol_gate, latch down to
        leverage_low. This is a ONE-WAY ratchet — it does not latch back up
        to leverage_high until the position exits and re-enters fresh.
        latch=False turns the ratchet into a two-way switch: while invested,
        leverage is leverage_low whenever vol >= vol_gate and leverage_high
        whenever it is below, re-evaluated every day.
        Exit is price-only (crossing below `lower`), regardless of vol.

    size_mode="vol_target" — continuous volatility targeting:
        While the signal is IN, the target position is
        min(vol_target / realized_vol, max_size); it is 0 while OUT.
        A trade only happens when |held - target| > rebalance_band, so the
        held size persists through small drifts (a no-trade band). This is
        path-dependent: `held` carries forward day to day.

    Cost model (all optional, default to zero — a no-cost call reproduces
    the pre-cost-model numbers exactly). This is written from the WisdomTree
    prospectus formula (base prospectus p.72 / p.199), independently of
    js/cost-model.js, so the two can be diffed. See cost-assumptions.json for
    where each product's figures come from.

        P(t) = P(t-1) * (1 + R) * (1 - CA)
        R    = L * total_return - (L-1) * (base_rate + funding_spread) * D/360
        CA   = mgmt_fee * D/360 + daily_swap_rate * D          (x min(L,1))
        total_return = price return + dividend_yield * D/365.25

    D is CALENDAR days since the previous row (3 over a weekend), never 1 per
    row — annual rates must accrue over a calendar year whether the asset has
    252 or 365 rows in it (same bug class as the CAGR row-count fix below).

        products         — list of dicts {leverage, mgmt_fee_pct,
                           daily_swap_rate_pct, funding_spread_pct}. An
                           exposure is held via the smallest product whose
                           leverage >= it (the largest if none is big enough).
        rate_monthly     — {"YYYY-MM": pct}, the Fed Funds / SONIA month
                           average; first/last value held outside its range.
        dividend_monthly — {"YYYY-MM": pct} yield, only for PRICE-only series.
        slippage_bps_round_trip — one-off cost split across each leg, charged
                           whenever exposure changes; not scaled by the size
                           of the change.

    Returns a dict:
        state       : array, exposure each day — a leverage multiplier under
                      "fixed", a fraction of capital (1.0 = 100%) under
                      "vol_target". 0 = out in both.
        target      : array, the pre-band target size ("vol_target" only;
                      equals state under "fixed")
        strat_ret   : array, daily strategy returns (state[t-1] applied to
                      day t's return — no lookahead)
        equity      : array, cumulative equity curve starting at 1.0
        sma, vol    : the underlying indicator arrays, for inspection
        stats       : dict of summary stats over the full evaluable period
                      (from the first valid SMA/vol day onward)
    """
    closes = np.asarray(closes, dtype=float)
    n_obs = len(closes)

    daily_ret = np.zeros(n_obs)
    daily_ret[1:] = closes[1:] / closes[:-1] - 1

    sma = compute_sma(closes, sma_n)
    needs_vol = vol_n is not None and (vol_gate is not None or size_mode == "vol_target")
    vol = realized_vol(closes, vol_n, annualization) if needs_vol else None

    start_idx = sma_n - 1
    if needs_vol:
        start_idx = max(start_idx, vol_n)

    state = np.zeros(n_obs)
    target = np.zeros(n_obs)
    pos = 0.0
    for i in range(start_idx, n_obs):
        upper = sma[i] * (1 + buffer)
        lower = sma[i] * (1 - buffer)
        v = vol[i] if vol is not None else None

        if size_mode == "vol_target":
            if closes[i] > upper:
                want = min(vol_target / v, max_size) if (v is not None and v > 0) else 0.0
            elif closes[i] < lower:
                want = 0.0
            else:
                want = pos  # inside the band (or exactly at the SMA): hold
            target[i] = want
            if abs(pos - want) > rebalance_band:
                pos = want
        else:
            if pos == 0:
                if closes[i] > upper:
                    if vol_gate is None:
                        pos = leverage_high
                    elif v is not None and v < vol_gate:
                        pos = leverage_high
                    # if vol_gate set but v >= vol_gate at the crossing: stay out
            else:
                if closes[i] < lower:
                    pos = 0.0
                elif vol_gate is not None and v is not None:
                    if latch:
                        if pos == leverage_high and v >= vol_gate:
                            pos = leverage_low
                    else:
                        pos = leverage_low if v >= vol_gate else leverage_high
            target[i] = pos
        state[i] = pos

    # Calendar days elapsed since the previous row (see cost-model docstring
    # above for why this must be actual elapsed days, not a flat 1/row).
    dt = pd.to_datetime(pd.Series(dates)).values
    days_elapsed = np.zeros(n_obs)
    days_elapsed[1:] = (dt[1:] - dt[:-1]).astype("timedelta64[D]").astype(float)

    prev_exposure = np.zeros(n_obs)
    prev_exposure[1:] = state[:-1]

    factors = np.ones(n_obs)
    for i in range(1, n_obs):
        e = prev_exposure[i]
        if e <= 0:
            continue
        ret = daily_ret[i]
        d = days_elapsed[i]
        month = str(dates[i - 1])[:7]
        if dividend_monthly:
            ret += _monthly(dividend_monthly, month) / 100.0 * d / 365.25
        base = _monthly(rate_monthly, month) if rate_monthly else 0.0
        factors[i] = product_factor(e, ret, d, base, pick_product(products, e))

    if slippage_bps_round_trip:
        changed = np.zeros(n_obs, dtype=bool)
        changed[1:] = state[1:] != state[:-1]
        factors[changed] *= (1 - slippage_bps_round_trip / 2 / 10000.0)

    strat_ret = factors - 1.0
    strat_ret[:start_idx + 1] = 0.0

    eval_ret = strat_ret[start_idx + 1:]
    eval_days = n_obs - (start_idx + 1)

    # Elapsed time must come from the actual dates, not the row count.
    # Rows are *observations*, not calendar days: an equity series has ~252
    # rows/year, so `eval_days / 365.25` would call a 97.9-year backtest 67.3
    # years and inflate its CAGR by ~1.5x. (It only looks right for BTC,
    # which trades every calendar day.) Falls back to rows/annualization if
    # the dates can't be parsed.
    try:
        years = (pd.Timestamp(dates[-1]) - pd.Timestamp(dates[start_idx + 1])).days / 365.25
    except (TypeError, ValueError):
        years = eval_days / annualization

    # Ruin: a loss worse than 1/leverage wipes the position out (at 5x, the
    # -20.5% of 1987-10-19 gives a factor of -0.02). A fund can't go negative —
    # it closes — so zero the factor from that day on, which makes the cumprod
    # absorbing at 0. Without this the curve flips sign and everything after is
    # meaningless. Mirrors backtestEquityCurve in js/strategy-engine.js.
    factors = 1 + eval_ret
    wiped = factors <= 0
    ruined_at = None
    if wiped.any():
        first = int(np.argmax(wiped))
        factors[first:] = 0.0
        ruined_at = dates[start_idx + 1 + first]

    equity = np.ones(n_obs)
    equity[start_idx + 1:] = np.cumprod(factors)
    equity[:start_idx + 1] = 1.0

    cum = equity[start_idx + 1:]
    total_return = cum[-1] if len(cum) else 1.0
    cagr = total_return ** (1 / years) - 1 if years > 0 else np.nan
    ann_vol = eval_ret.std() * np.sqrt(annualization) if len(eval_ret) else np.nan
    sharpe = (eval_ret.mean() * annualization) / ann_vol if ann_vol else np.nan
    running_max = np.maximum.accumulate(cum) if len(cum) else np.array([1.0])
    dd = cum / running_max - 1 if len(cum) else np.array([0.0])
    max_dd = dd.min() if len(dd) else 0.0
    calmar = cagr / abs(max_dd) if max_dd < 0 else np.nan
    n_trades = int(np.sum(np.abs(np.diff(state[start_idx:] > 0))))

    stats = dict(
        start_date=dates[start_idx + 1] if start_idx + 1 < n_obs else None,
        end_date=dates[-1],
        years=years,
        total_return_pct=total_return * 100 - 100,
        cagr_pct=cagr * 100,
        ann_vol_pct=ann_vol * 100,
        sharpe=sharpe,
        max_dd_pct=max_dd * 100,
        calmar=calmar,
        n_trades=n_trades,
        ruined_at=ruined_at,
    )

    return dict(state=state, target=target, strat_ret=strat_ret, equity=equity,
                sma=sma, vol=vol, stats=stats, start_idx=start_idx,
                ruined_at=ruined_at)


def grid_search(dates, closes, sma_values, buffer_values, annualization=252,
                 vol_n=None, vol_gate=None, leverage_high=1.0, leverage_low=1.0):
    """
    Sweep sma_n x buffer combinations, returning one row of stats per
    combination as a pandas DataFrame. Same vol-gate/leverage overlay
    applies uniformly across the whole grid if supplied.
    """
    rows = []
    for n in sma_values:
        for buf in buffer_values:
            res = run_backtest(dates, closes, n, buf,
                                vol_n=vol_n, vol_gate=vol_gate,
                                leverage_high=leverage_high, leverage_low=leverage_low,
                                annualization=annualization)
            row = dict(sma_n=n, buffer_pct=buf * 100)
            row.update(res["stats"])
            rows.append(row)
    return pd.DataFrame(rows)


def conditional_forward_return(dates, closes, sma_n, buffer, extension_threshold,
                                 vol_n=None, vol_gate=None,
                                 leverage_high=1.0, leverage_low=1.0,
                                 annualization=252):
    """
    Historical "what happens from here" study: for every contiguous IN
    episode, find the first day the price closes at least
    `extension_threshold` above the SMA, then measure the forward return
    from that point to the episode's eventual exit.

    Returns a DataFrame with one row per qualifying episode: trigger date,
    extension at trigger, exit date, days held, and forward return (%).
    Compounds actual daily strategy returns (including leverage path if a
    vol-gate is supplied), not a static approximation.
    """
    closes = np.asarray(closes, dtype=float)
    n_obs = len(closes)
    res = run_backtest(dates, closes, sma_n, buffer,
                        vol_n=vol_n, vol_gate=vol_gate,
                        leverage_high=leverage_high, leverage_low=leverage_low,
                        annualization=annualization)
    state, sma, strat_ret, start_idx = res["state"], res["sma"], res["strat_ret"], res["start_idx"]
    extension = closes / sma - 1

    episodes = []
    i = start_idx
    while i < n_obs:
        if state[i] > 0:
            s = i
            while i < n_obs and state[i] > 0:
                i += 1
            episodes.append((s, i - 1))
        else:
            i += 1

    rows = []
    for s, e in episodes:
        trig = None
        for j in range(s, e + 1):
            if extension[j] >= extension_threshold:
                trig = j
                break
        if trig is not None:
            path = strat_ret[trig + 1:e + 1]
            fwd = np.prod(1 + path) - 1 if len(path) else 0.0
            rows.append(dict(
                trigger_date=dates[trig], trigger_extension_pct=extension[trig] * 100,
                exit_date=dates[e], days_held=e - trig, forward_return_pct=fwd * 100,
            ))
    return pd.DataFrame(rows)


def conditional_odds(dates, closes, sma_n, buffer, bands=(0, 5, 10, 15, 20),
                      now_tolerance=1.0, **backtest_kwargs):
    """
    "What usually happens from here": bucket historical days by how far price
    sat from the SMA, and report the distribution of outcomes between that day
    and the next flip.

    Only days matching the CURRENT regime (in-position vs. flat) are pooled,
    since "+10% while invested" and "+10% while in cash" are different
    questions. The final episode is dropped — it hasn't flipped yet, so its
    outcome is unknown and including it would bias results downward.

    For in-position days the result is the strategy's own compounded return to
    the exit; for flat days it is the underlying asset's move while sitting
    out (the strategy itself earns 0% flat).

    Note on sample size: consecutive days inside one episode share an exit, so
    they are NOT independent observations. `episodes` is the honest measure of
    how much evidence backs a row; `n_days` will always look far larger.

    Returns a DataFrame with one row per band plus a "Now" row covering
    today's extension +/- `now_tolerance` percentage points.
    """
    closes = np.asarray(closes, dtype=float)
    n_obs = len(closes)
    res = run_backtest(dates, closes, sma_n, buffer, **backtest_kwargs)
    state, sma, start_idx = res["state"], res["sma"], res["start_idx"]
    extension = (closes / sma - 1) * 100

    # Contiguous runs of in/flat, minus the still-open final episode.
    episodes, i = [], start_idx
    while i < n_obs:
        in_pos = state[i] > 0
        s = i
        while i < n_obs and (state[i] > 0) == in_pos:
            i += 1
        episodes.append((s, i - 1, in_pos))
    episodes = episodes[:-1]

    rows = []
    for ep_idx, (s, e, in_pos) in enumerate(episodes):
        exit_k = min(e + 1, n_obs - 1)
        for t in range(s, e + 1):
            if np.isnan(sma[t]):
                continue
            if in_pos:
                growth = 1.0
                for k in range(t + 1, exit_k + 1):
                    prev = state[k - 1]
                    growth *= (1 + prev * (closes[k] / closes[k - 1] - 1)) if prev > 0 else 1.0
                result = (growth - 1) * 100
            else:
                result = (closes[exit_k] / closes[t] - 1) * 100
            rows.append(dict(
                episode=ep_idx, ext=extension[t], in_pos=in_pos, result=result,
                days=(pd.Timestamp(dates[exit_k]) - pd.Timestamp(dates[t])).days,
            ))
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    current_in = state[-1] > 0
    current_ext = extension[-1]
    pool = df[df["in_pos"] == current_in]

    def summarize(label, subset):
        if subset.empty:
            return dict(band=label, n_days=0, episodes=0)
        return dict(
            band=label, n_days=len(subset), episodes=subset["episode"].nunique(),
            pct_up=(subset["result"] > 0).mean() * 100,
            worst=subset["result"].min(), typical=subset["result"].median(),
            best=subset["result"].max(),
            days_min=subset["days"].min(), days_typical=subset["days"].median(),
            days_max=subset["days"].max(),
        )

    out = [summarize(f"Now ({current_ext:+.1f}% +/-{now_tolerance})",
                     pool[(pool["ext"] - current_ext).abs() <= now_tolerance])]
    sign = 1 if current_in else -1
    for j, lo in enumerate(bands):
        hi = bands[j + 1] if j + 1 < len(bands) else None
        signed = pool["ext"] * sign
        sel = pool[(signed >= lo) & ((signed < hi) if hi is not None else True)]
        out.append(summarize(f"{lo}-{hi}%" if hi else f"{lo}%+", sel))
    return pd.DataFrame(out)


# ---------------------------------------------------------------------------
# Validated parameter sets used in this project's live tracker and analysis.
# Pass closes/dates from the `prices` table (Supabase), filtered by asset.
# ---------------------------------------------------------------------------
# Shelved 2026-09-09, kept for reference/comparison — superseded by BTC_V2_PARAMS.
BTC_PARAMS = dict(sma_n=40, buffer=0.0, annualization=365)

# Live BTC strategy: 120d crossover, sized at 60%/vol capped at 100%, with a
# 15pp no-trade band (~12 trades/yr over the last decade).
BTC_V2_PARAMS = dict(sma_n=120, buffer=0.0, annualization=365,
                      vol_n=20, size_mode="vol_target", vol_target=0.60,
                      max_size=1.0, rebalance_band=0.15)

SPX_PARAMS = dict(sma_n=200, buffer=0.03, annualization=252,
                   vol_n=20, vol_gate=0.22, leverage_high=5.0, leverage_low=3.0)
