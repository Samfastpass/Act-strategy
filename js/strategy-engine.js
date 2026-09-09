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

    var vol = new Array(n).fill(null);
    if (needsVol) {
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
    }

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
          else if (lev.gated != null && cur === lev.base && volGate != null && v !== null && v >= volGate) cur = lev.gated;
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

  // Equity curve (starting at 1.0 at startIdx), applying leveraged daily
  // simple returns while in position and staying flat (cash) otherwise.
  // A day's return is scaled by the leverage state as of the *previous*
  // day's close (the position you were already holding going into that
  // day) — never the state computed using that same day's own close.
  function backtestEquityCurve(prices, params) {
    var w = walk(prices, params);
    var n = w.closes.length;
    var firstIdx = w.startIdx;
    if (firstIdx >= n) return [];
    var equity = new Array(n).fill(null);
    equity[firstIdx] = 1;
    for (var i = firstIdx + 1; i < n; i++) {
      var prevState = w.state[i - 1] || 0;
      // A daily-rebalanced Nx-leveraged position targets N times the
      // day's *simple* return, not the price ratio raised to the Nth
      // power (that would compound the whole cumulative return by a
      // power of N, wildly overstating results — the ratio-to-a-power
      // form is only equivalent to this at leverage 1). Matches
      // strategy_lib.py's strat_ret = state[t-1] * daily_ret[t].
      var simpleRet = w.closes[i] / w.closes[i - 1] - 1;
      var factor = prevState > 0 ? 1 + prevState * simpleRet : 1;
      equity[i] = equity[i - 1] * factor;
    }
    var out = [];
    for (var j = firstIdx; j < n; j++) out.push({ date: prices[j].date, equity: equity[j] });
    return out;
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

  return { walk: walk, computeStatus: computeStatus, backtestEquityCurve: backtestEquityCurve, cagr: cagr };
})();
