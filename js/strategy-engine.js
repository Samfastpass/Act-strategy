// Generic SMA-crossover strategy engine.
//
// Ported from strategy_lib.py's run_backtest(), which is this project's
// validated ground truth (see PROJECT_NOTES.md) — if this file and that
// one ever disagree, strategy_lib.py wins. One parameterized state-machine
// walk that both strategies (and any future ones defined in
// strategies.json) run through. A strategy with buffer=0 and no vol gate
// (BTC) degenerates to a plain memoryless crossover; a strategy with a
// buffer and a vol gate (S&P) gets hysteresis bands and a one-way leverage
// ratchet.
window.StrategyEngine = (function () {

  // Annualized realized vol from the trailing volLen daily log returns
  // (sample stdev, ddof=1) — matches strategy_lib.realized_vol. null until
  // volLen returns exist.
  function realizedVol(closes, volLen, annualization) {
    var n = closes.length;
    var vol = new Array(n).fill(null);
    var logret = new Array(n).fill(0);
    for (var i2 = 1; i2 < n; i2++) logret[i2] = Math.log(closes[i2] / closes[i2 - 1]);
    for (var i3 = volLen; i3 < n; i3++) {
      var mean = 0;
      for (var k = i3 - volLen + 1; k <= i3; k++) mean += logret[k];
      mean /= volLen;
      var vv = 0;
      for (var k2 = i3 - volLen + 1; k2 <= i3; k2++) vv += (logret[k2] - mean) * (logret[k2] - mean);
      vv /= (volLen - 1);
      vol[i3] = Math.sqrt(vv) * Math.sqrt(annualization);
    }
    return vol;
  }

  // Walks full price history once, computing the rolling SMA, the
  // (optional) realized-vol series, and the state (0 = flat, otherwise the
  // currently-applied leverage multiple) at every day. Shared by
  // computeStatus() and backtestEquityCurve() so there is exactly one
  // place that encodes the entry/exit/ratchet rules.
  function walk(prices, params) {
    var n = prices.length;
    var closes = prices.map(function (p) { return p.close; });
    var smaLen = params.smaLen;
    var buffer = params.buffer || 0;
    var volLen = params.volLen;
    var volGate = params.volGate;
    var annualization = params.annualization || 252;
    var lev = params.leverage || { base: 1, gated: null };
    var sizing = params.sizing || { mode: "fixedLeverage" };
    // Only matters when a vol gate reduces leverage; default is the original
    // one-way ratchet (params.latch === false makes it re-lever when vol calms).
    var latched = params.latch !== false;
    // Vol feeds either the gate (fixedLeverage) or the position size
    // (volTarget), so it's needed whenever volLen is set and something uses it.
    var needsVol = !!volLen && (volGate != null || sizing.mode === "volTarget");

    var sma = new Array(n).fill(null);
    var sum = 0;
    for (var i = 0; i < n; i++) {
      sum += closes[i];
      if (i >= smaLen) sum -= closes[i - smaLen];
      if (i >= smaLen - 1) sma[i] = sum / smaLen;
    }

    // A caller sweeping many walks over the same prices (the explorer's matrix)
    // can precompute the vol series once and pass it in as params.volSeries.
    var vol = needsVol ? (params.volSeries || realizedVol(closes, volLen, annualization)) : new Array(n).fill(null);

    // Matches strategy_lib.py's start_idx: when vol is in play, the walk
    // can't start until both the SMA *and* the vol window are available.
    var startIdx = needsVol ? Math.max(smaLen - 1, volLen) : smaLen - 1;

    // state[i] is exposure at day i's close: 0 = flat, otherwise the
    // leverage multiple (fixedLeverage) or the fraction of capital held
    // (volTarget, where 1.0 = 100%).
    var state = new Array(n).fill(0);
    var target = new Array(n).fill(0);
    var cur = 0;
    for (var i4 = startIdx; i4 < n; i4++) {
      if (sma[i4] === null) { state[i4] = cur; target[i4] = cur; continue; }
      var upper = sma[i4] * (1 + buffer), lower = sma[i4] * (1 - buffer);
      var v = vol[i4];

      if (sizing.mode === "volTarget") {
        // Size continuously as volTarget/vol, capped, and only actually
        // trade when held size drifts more than rebalanceBand from target.
        var want;
        if (closes[i4] > upper) want = (v !== null && v > 0) ? Math.min(sizing.volTarget / v, sizing.maxSize) : 0;
        else if (closes[i4] < lower) want = 0;
        else want = cur; // inside the band (or exactly at the SMA): hold
        target[i4] = want;
        if (Math.abs(cur - want) > sizing.rebalanceBand) cur = want;
      } else {
        if (cur === 0) {
          var volOk = volGate == null ? true : (v !== null && v < volGate);
          if (closes[i4] > upper && volOk) cur = lev.base;
        } else {
          if (closes[i4] < lower) cur = 0;
          else if (lev.gated != null && volGate != null && v !== null) {
            if (latched) {
              // One-way ratchet: once vol has spiked, stay at the reduced
              // leverage until the position exits and re-enters fresh.
              if (cur === lev.base && v >= volGate) cur = lev.gated;
            } else {
              // Unlatched: leverage follows vol both ways, day by day.
              cur = v >= volGate ? lev.gated : lev.base;
            }
          }
        }
        target[i4] = cur;
      }
      state[i4] = cur;
    }

    return { closes: closes, sma: sma, vol: vol, state: state, target: target, startIdx: startIdx };
  }

  // Current status: price/SMA, extension %, in/out + leverage state, and
  // the % move needed to flip ("cushion").
  function computeStatus(prices, params) {
    var w = walk(prices, params);
    var n = w.closes.length;
    var buffer = params.buffer || 0;
    var sizing = params.sizing || { mode: "fixedLeverage" };
    var cur = w.closes[n - 1], curSma = w.sma[n - 1], curVol = w.vol[n - 1];
    var state = w.state[n - 1];
    var prevState = n >= 2 ? w.state[n - 2] : 0;
    var target = w.target[n - 1];
    var ext = (cur / curSma - 1) * 100;
    var upper = curSma * (1 + buffer), lower = curSma * (1 - buffer);
    var inPos = state > 0;
    var cushion = inPos ? (1 - lower / cur) * 100 : (upper / cur - 1) * 100;
    return {
      sma: curSma, cur: cur, ext: ext,
      vol: curVol !== null ? curVol * 100 : null,
      state: state, inPos: inPos, cushion: cushion,
      // volTarget only: `target` is the size today's vol implies before the
      // no-trade band is applied; `state` is what you should actually hold
      // after it. They differ whenever the band suppressed a rebalance.
      // tradeDue means the latest close moved the held size off yesterday's.
      target: target,
      prevState: prevState,
      tradeDue: sizing.mode === "volTarget" && state !== prevState
    };
  }

  // The exposure a walk implies on day i. A gated walk (the explorer's
  // vol-gated mode) already holds real leverage multiples in state[]; a binary
  // walk is 0/1 and is scaled by `leverage`.
  function exposureAt(wk, i, leverage) {
    return wk.gated ? wk.state[i] : (wk.state[i] > 0 ? leverage : 0);
  }

  function daysBetween(a, b) { return (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24); }

  // Day numbers (UTC days since the epoch) for a price series, computed once
  // per series. compoundEquity needs the calendar gap between every pair of
  // rows; parsing two date strings per row per call made the explorer's 49-cell
  // matrix several times slower than it needed to be.
  var dayNumCache = new WeakMap();
  function dayNumbers(prices) {
    var hit = dayNumCache.get(prices);
    if (hit && hit.n === prices.length && hit.last === prices[prices.length - 1].date) return hit.days;
    var days = new Array(prices.length);
    for (var i = 0; i < prices.length; i++) {
      var d = prices[i].date;
      days[i] = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
    }
    dayNumCache.set(prices, { n: prices.length, last: prices[prices.length - 1].date, days: days });
    return days;
  }

  // The single shared compounding core. Used by backtestEquityCurve() below
  // AND by the S&P Leverage explorer's matrix and performance chart — those
  // used to each carry their own inline copy of this loop, which is exactly
  // the kind of duplication that let the leverage bug (see PROJECT_NOTES.md,
  // the "ratio raised to a power" fix) ship in one place and not another.
  // One function, one place to audit.
  //
  // `exposure[i]` is the ACTUAL leverage/fraction applied on day i — already
  // resolved (0 when flat, the leverage multiple or sizing fraction when
  // in). A day's return is scaled by the *previous* day's exposure (the
  // position already held going into that day), never the same day's own
  // close — the no-lookahead rule.
  //
  // `costs` (all optional, default to zero — so a no-costs call is
  // byte-identical to the pre-cost-model behavior). The fee/financing maths
  // itself lives in js/cost-model.js (CostModel.dailyGrowth, the WisdomTree
  // prospectus formula) — this function only feeds it the right inputs:
  //   products                           — [{ leverage, mgmtFeePct,
  //                                        dailySwapRatePct, fundingSpreadPct }]
  //                                        the real products available at each
  //                                        leverage; a day's exposure is held
  //                                        via CostModel.pickProduct()
  //   rateForDate(dateStr) -> pct        — the day's reference short rate
  //                                        (Fed Funds / SONIA); omit for 0
  //   dividendYieldForDate(dateStr) -> pct — for PRICE-only series (SPX_MERGED)
  //                                        whose leveraged products are
  //                                        total-return: adds yield x D/365.25
  //                                        to the day's return so dividends
  //                                        are passed through (x leverage)
  //   slippageBpsRoundTrip               — one-off cost split across each
  //                                        leg, charged whenever exposure
  //                                        actually changes (entry, exit, a
  //                                        vol-gate ratchet, or a volTarget
  //                                        rebalance) — not a daily drag, and
  //                                        not scaled by the size of the
  //                                        change (a full entry and a partial
  //                                        ratchet cost the same modelled
  //                                        slippage; a reasonable
  //                                        simplification given the tiers
  //                                        are themselves approximate — see
  //                                        cost-assumptions.json)
  //
  // Costs accrue by calendar days elapsed since the previous row, not once
  // per row: TER/swap-rate figures are annual rates meant to compound over a
  // calendar year, and an equity-index asset only has ~252 rows/year, not
  // 365 — charging once per row would under-charge to ~69% of the stated
  // annual cost. This is the same bug class as the CAGR row-count fix
  // (PROJECT_NOTES.md, "Fixed 2026-09-17"), relocated from years-elapsed to
  // cost-accrual. Bitcoin trades every calendar day, so daysElapsed is
  // always 1 there and this is a no-op for it.
  function compoundEquity(prices, exposure, fromIdx, toIdx, costs) {
    costs = costs || {};
    var products = costs.products || null;
    var rateForDate = costs.rateForDate || function () { return 0; };
    var dividendYieldForDate = costs.dividendYieldForDate || null;
    var slippageBps = costs.slippageBpsRoundTrip || 0;

    var dayNums = dayNumbers(prices);
    var equity = new Array(toIdx + 1).fill(null);
    equity[fromIdx] = 1;
    var ruinedAt = null;

    for (var i = fromIdx + 1; i <= toIdx; i++) {
      var prevExposure = exposure[i - 1] || 0;
      // A daily-rebalanced Nx-leveraged position targets N times the day's
      // *simple* return, not the price ratio raised to the Nth power (that
      // would compound the whole cumulative return by a power of N, wildly
      // overstating results). Matches strategy_lib.py's
      // strat_ret = state[t-1] * daily_ret[t].
      var simpleRet = prices[i].close / prices[i - 1].close - 1;
      var daysElapsed = dayNums[i] - dayNums[i - 1];

      var factor = 1;
      if (prevExposure > 0) {
        if (dividendYieldForDate) simpleRet += dividendYieldForDate(prices[i - 1].date) / 100 * daysElapsed / 365.25;
        factor = window.CostModel.dailyGrowth(
          prevExposure, simpleRet, daysElapsed, rateForDate(prices[i - 1].date),
          window.CostModel.pickProduct(products, prevExposure)
        );
      }

      if (exposure[i] !== prevExposure && slippageBps > 0 && equity[i - 1] > 0) {
        factor *= 1 - slippageBps / 2 / 10000;
      }

      // Ruin: a loss worse than 1/leverage (now sooner, once costs are
      // subtracted) wipes the position out entirely — a fund can't go
      // negative, it closes. Floor at zero, which is absorbing.
      if (factor <= 0) {
        if (ruinedAt === null) ruinedAt = prices[i].date;
        equity[i] = 0;
      } else {
        equity[i] = equity[i - 1] <= 0 ? 0 : equity[i - 1] * factor;
      }
    }

    var out = [];
    for (var j = fromIdx; j <= toIdx; j++) out.push({ date: prices[j].date, equity: equity[j] });
    out.ruinedAt = ruinedAt;
    return out;
  }

  // Equity curve (starting at 1.0 at startIdx) for a strategy's own state,
  // with no costs — the site's Developed-tab strategies aren't cost-modelled
  // (only the explorer is), so this stays exactly as before.
  function backtestEquityCurve(prices, params) {
    var w = walk(prices, params);
    var n = w.closes.length;
    var firstIdx = w.startIdx;
    if (firstIdx >= n) return [];
    return compoundEquity(prices, w.state, firstIdx, n - 1, null);
  }

  // CAGR % over the trailing `years` (or the whole curve if years is null).
  function cagr(equityCurve, years) {
    if (!equityCurve || equityCurve.length < 2) return null;
    var last = equityCurve[equityCurve.length - 1];
    var lastDate = new Date(last.date);
    var targetDate;
    if (years == null) {
      targetDate = new Date(equityCurve[0].date);
    } else {
      targetDate = new Date(lastDate);
      targetDate.setFullYear(targetDate.getFullYear() - years);
    }
    var start = null;
    for (var i = 0; i < equityCurve.length; i++) {
      if (new Date(equityCurve[i].date) >= targetDate) { start = equityCurve[i]; break; }
    }
    if (!start) start = equityCurve[0];
    var startDate = new Date(start.date);
    var yearsSpan = (lastDate - startDate) / (1000 * 60 * 60 * 24 * 365.25);
    if (yearsSpan <= 0 || start.equity <= 0) return null;
    return (Math.pow(last.equity / start.equity, 1 / yearsSpan) - 1) * 100;
  }

  return {
    walk: walk, computeStatus: computeStatus, backtestEquityCurve: backtestEquityCurve,
    compoundEquity: compoundEquity, cagr: cagr, realizedVol: realizedVol, exposureAt: exposureAt
  };
})();
