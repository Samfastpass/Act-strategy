// Conditional "odds" tables: given how far price sits from the moving
// average, what has historically happened between here and the next flip?
//
// Method: split history into episodes (contiguous runs of in-position or
// flat), drop the final still-open episode — it has no known exit, and
// including it would bias every duration and return downward — then for
// each day in a completed episode record the forward result to that
// episode's end. Rows are conditioned on matching today's state, because
// "what happens from +10% while invested" and "what happens from +10%
// while in cash" are different questions.
window.Odds = (function () {

  function median(sorted) {
    if (!sorted.length) return null;
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function daysBetween(aDate, bDate) {
    return Math.round((new Date(bDate) - new Date(aDate)) / (1000 * 60 * 60 * 24));
  }

  // One sample per day of a completed episode.
  function buildSamples(prices, walkResult) {
    var state = walkResult.state, closes = walkResult.closes, sma = walkResult.sma;
    var n = closes.length;
    var startIdx = walkResult.startIdx;

    // Episode boundaries: runs where "is in position" stays constant.
    var episodes = [];
    var i = startIdx;
    while (i < n) {
      var inPos = state[i] > 0;
      var s = i;
      while (i < n && (state[i] > 0) === inPos) i++;
      episodes.push({ start: s, end: i - 1, inPos: inPos });
    }
    // Drop the final episode — it hasn't flipped yet (right-censored).
    episodes.pop();

    var samples = [];
    episodes.forEach(function (ep, epIndex) {
      var exitK = Math.min(ep.end + 1, n - 1); // the day the flip lands on
      // suffix[t] = compounded growth from day t to the exit, so each day's
      // forward return is O(1) instead of re-multiplying the whole tail.
      //   suffix[exitK] = 1;  suffix[t] = factor(t+1) * suffix[t+1]
      // where factor(k) = 1 + state[k-1] * return(k) — the same
      // previous-day-state rule the backtest uses.
      var suffix = new Array(exitK + 1);
      suffix[exitK] = 1;
      if (ep.inPos) {
        for (var t2 = exitK - 1; t2 >= ep.start; t2--) {
          var prev = state[t2] || 0;
          var r = closes[t2 + 1] / closes[t2] - 1;
          suffix[t2] = (prev > 0 ? 1 + prev * r : 1) * suffix[t2 + 1];
        }
      }
      for (var t = ep.start; t <= ep.end; t++) {
        if (sma[t] === null) continue;
        var result = ep.inPos
          // Strategy's own compounded return from t to the exit, using the
          // same previous-day-state rule as the backtest (no lookahead).
          ? (suffix[t] - 1) * 100
          // Flat: the strategy earns 0%, so the informative number is what
          // the underlying asset did while it sat the move out.
          : (closes[exitK] / closes[t] - 1) * 100;
        samples.push({
          ext: (closes[t] / sma[t] - 1) * 100,
          inPos: ep.inPos,
          result: result,
          days: daysBetween(prices[t].date, prices[exitK].date),
          ep: epIndex
        });
      }
    });
    return samples;
  }

  function countEpisodes(subset) {
    var seen = {};
    subset.forEach(function (s) { seen[s.ep] = true; });
    return Object.keys(seen).length;
  }

  function summarize(label, subset, isCurrent) {
    if (!subset.length) return { label: label, n: 0, episodes: 0, isCurrent: !!isCurrent };
    var results = subset.map(function (s) { return s.result; }).sort(function (a, b) { return a - b; });
    var days = subset.map(function (s) { return s.days; }).sort(function (a, b) { return a - b; });
    var wins = subset.filter(function (s) { return s.result > 0; }).length;
    return {
      label: label,
      n: subset.length,
      // Days inside one episode share an outcome, so episode count is the
      // honest measure of how many independent observations back a row.
      episodes: countEpisodes(subset),
      winPct: (wins / subset.length) * 100,
      worst: results[0],
      typical: median(results),
      best: results[results.length - 1],
      daysMin: days[0],
      daysTypical: median(days),
      daysMax: days[days.length - 1],
      isCurrent: !!isCurrent
    };
  }

  // Returns { inPos, currentExt, nowRow, rows[] } ready to render.
  function compute(prices, params, walkResult, status) {
    var samples = buildSamples(prices, walkResult);
    var inPos = status.inPos;
    var currentExt = status.ext;

    // Only days in the same regime are comparable.
    var pool = samples.filter(function (s) { return s.inPos === inPos; });

    // The ±1pp "now" row: the tightest, most directly relevant slice.
    var nowRow = summarize(
      "Now (" + (currentExt >= 0 ? "+" : "") + currentExt.toFixed(1) + "% ±1)",
      pool.filter(function (s) { return Math.abs(s.ext - currentExt) <= 1; }),
      true
    );

    // Wider context bands, mirrored to negative extension when flat.
    var edges = [0, 5, 10, 15, 20];
    var rows = edges.map(function (lo, i) {
      var hi = edges[i + 1];
      var label, test;
      if (inPos) {
        label = hi ? lo + "–" + hi + "%" : lo + "%+";
        test = function (s) { return s.ext >= lo && (hi == null || s.ext < hi); };
      } else {
        label = hi ? "−" + lo + " to −" + hi + "%" : "below −" + lo + "%";
        test = function (s) { return -s.ext >= lo && (hi == null || -s.ext < hi); };
      }
      var band = summarize(label, pool.filter(test));
      band.isCurrent = inPos
        ? (currentExt >= lo && (hi == null || currentExt < hi))
        : (-currentExt >= lo && (hi == null || -currentExt < hi));
      return band;
    });

    return {
      inPos: inPos, currentExt: currentExt, nowRow: nowRow, rows: rows,
      totalSamples: pool.length, totalEpisodes: countEpisodes(pool)
    };
  }

  return { compute: compute };
})();
