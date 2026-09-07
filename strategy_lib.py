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


def run_backtest(dates, closes, sma_n, buffer,
                  vol_n=None, vol_gate=None, leverage_high=1.0, leverage_low=1.0,
                  annualization=252):
    """
    Run the SMA + buffer trend filter, with an optional volatility-gated
    leverage overlay, over a full price series.

    Signal (always present):
        upper = SMA * (1 + buffer); lower = SMA * (1 - buffer)
        OUT -> IN  when close crosses above upper
        IN  -> OUT when close crosses below lower
        (buffer=0 collapses this to a pure crossover with no hysteresis)

    Leverage overlay (only if vol_gate is not None):
        On entry: leverage_high if realized vol < vol_gate, else leverage_low.
        While invested: if vol rises to >= vol_gate, latch down to
        leverage_low. This is a ONE-WAY ratchet — it does not latch back up
        to leverage_high until the position exits and re-enters fresh.
        Exit is price-only (crossing below `lower`), regardless of vol.

    Returns a dict:
        state       : array, leverage multiplier each day (0 = out)
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
    vol = realized_vol(closes, vol_n, annualization) if vol_gate is not None else None

    start_idx = sma_n - 1
    if vol_gate is not None:
        start_idx = max(start_idx, vol_n)

    state = np.zeros(n_obs)
    pos = 0.0
    for i in range(start_idx, n_obs):
        upper = sma[i] * (1 + buffer)
        lower = sma[i] * (1 - buffer)
        v = vol[i] if vol is not None else None

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
            elif vol_gate is not None and pos == leverage_high and v is not None and v >= vol_gate:
                pos = leverage_low
        state[i] = pos

    strat_ret = np.zeros(n_obs)
    strat_ret[start_idx + 1:] = state[start_idx:-1] * daily_ret[start_idx + 1:]

    eval_ret = strat_ret[start_idx + 1:]
    eval_days = n_obs - (start_idx + 1)
    years = eval_days / 365.25

    equity = np.ones(n_obs)
    equity[start_idx + 1:] = np.cumprod(1 + eval_ret)
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
    )

    return dict(state=state, strat_ret=strat_ret, equity=equity,
                sma=sma, vol=vol, stats=stats, start_idx=start_idx)


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


# ---------------------------------------------------------------------------
# Validated parameter sets used in this project's live tracker and analysis.
# Pass closes/dates from the `prices` table (Supabase), filtered by asset.
# ---------------------------------------------------------------------------
BTC_PARAMS = dict(sma_n=40, buffer=0.0, annualization=365)
SPX_PARAMS = dict(sma_n=200, buffer=0.03, annualization=252,
                   vol_n=20, vol_gate=0.22, leverage_high=5.0, leverage_low=3.0)
