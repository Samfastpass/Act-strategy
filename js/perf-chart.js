// Performance + underwater chart for the leverage explorer.
//
// Two stacked plots sharing one x-axis: a mode-switchable top plot (total
// return on a log axis, or one of three annualised views on a linear % axis)
// and an always-present underwater panel showing how far below the running
// peak the strategy was on any given day.
//
// The underwater panel is the point of this chart. "Max drawdown −99.8%" tells
// you the depth but hides the duration, and at these leverages the duration is
// the real cost — decades spent below a prior peak.
window.PerfChart = (function () {
  var fmt = window.App.fmt;
  var Plot = window.Plot;

  // Compound the selected window via the shared StrategyEngine.compoundEquity
  // core — the same one the explorer's matrix (js/explorer.js's windowStats)
  // and the Developed tab's equity chart use. This used to be its own
  // parallel inline loop; consolidated so leverage/ruin/cost logic lives in
  // exactly one place. (An earlier version of this file deliberately kept
  // two independent implementations so their drawdown figures cross-checked
  // each other — reasonable when the loop was simple, but the cost model
  // added enough surface area that two copies risked silently drifting out
  // of sync, which is exactly the failure mode PROJECT_NOTES.md's leverage
  // bug came from. The cross-check role now lives in strategy_lib.py plus
  // one-off independent verification, not a second production code path.)
  function buildSeries(prices, wk, leverage, lo, hi, costs) {
    var exposure = new Array(hi + 1);
    for (var i = lo; i <= hi; i++) exposure[i] = window.StrategyEngine.exposureAt(wk, i, leverage);
    var curve = window.StrategyEngine.compoundEquity(prices, exposure, lo, hi, costs || null);

    var base = prices[lo].close;
    // Buy & hold reference: unleveraged and cost-free, but with dividends
    // reinvested when the series is price-only — otherwise the strategy (which
    // receives them) would be compared against a benchmark that doesn't.
    var holdCurve = null;
    if (costs && costs.dividendYieldForDate) {
      var ones = new Array(hi + 1).fill(1);
      holdCurve = window.StrategyEngine.compoundEquity(prices, ones, lo, hi, {
        products: [{ leverage: 1 }], dividendYieldForDate: costs.dividendYieldForDate
      });
    }
    var peak = 1;
    var out = curve.map(function (p, idx) {
      var i = lo + idx;
      if (p.equity > peak) peak = p.equity;
      var dd = peak > 0 ? p.equity / peak - 1 : -1;
      return { date: p.date, eq: p.equity, dd: dd, hold: holdCurve ? holdCurve[idx].equity : prices[i].close / base };
    });
    var ruinIdx = curve.ruinedAt ? out.findIndex(function (p) { return p.date === curve.ruinedAt; }) : -1;
    return { pts: out, ruinIdx: ruinIdx };
  }

  // --- annualised transforms ---------------------------------------------
  function yearsBetween(a, b) { return (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 365.25); }
  function annualise(ratio, years) {
    if (years <= 0) return null;
    if (ratio <= 0) return -100;           // wiped out: -100%/yr, not -Infinity
    return (Math.pow(ratio, 1 / years) - 1) * 100;
  }

  // One bar per calendar year. The first and last years in a window are
  // usually partial; they're computed from the window's own edges and flagged,
  // rather than annualised into something misleading.
  function calendarYears(pts) {
    var byYear = {};
    pts.forEach(function (p) {
      var y = p.date.slice(0, 4);
      if (!byYear[y]) byYear[y] = { year: y, first: p, last: p };
      byYear[y].last = p;
    });
    var years = Object.keys(byYear).sort();
    var rows = [];
    for (var i = 0; i < years.length; i++) {
      var y = byYear[years[i]];
      // Chain from the previous year's close so a full year is a true
      // year-on-year return, not first-trading-day to last.
      var start = i > 0 ? byYear[years[i - 1]].last : y.first;
      var partial = (i === 0 && y.first.date.slice(5) > "01-10")
        || (i === years.length - 1 && y.last.date.slice(5) < "12-20");
      var ret = start.eq > 0 ? (y.last.eq / start.eq - 1) * 100 : (y.last.eq > 0 ? 0 : -100);
      if (start.eq === 0) ret = 0; // already dead; no further loss to show
      rows.push({ label: years[i], value: ret, partial: partial, date: y.last.date });
    }
    return rows;
  }

  function rollingAnnualised(pts, years) {
    var out = [], j = 0;
    for (var i = 0; i < pts.length; i++) {
      var cutoff = new Date(pts[i].date);
      cutoff.setFullYear(cutoff.getFullYear() - years);
      while (j < i && new Date(pts[j].date) < cutoff) j++;
      if (j === 0 && new Date(pts[0].date) > cutoff) continue; // not enough history yet
      var span = yearsBetween(pts[j].date, pts[i].date);
      if (span < years * 0.9) continue;
      var v = pts[j].eq > 0 ? annualise(pts[i].eq / pts[j].eq, span) : -100;
      if (v != null) out.push({ date: pts[i].date, value: v });
    }
    return out;
  }

  function sinceStart(pts) {
    var out = [];
    for (var i = 1; i < pts.length; i++) {
      var span = yearsBetween(pts[0].date, pts[i].date);
      if (span < 0.75) continue;           // sub-year stubs annualise to nonsense
      var v = annualise(pts[i].eq / pts[0].eq, span);
      if (v != null) out.push({ date: pts[i].date, value: v });
    }
    return out;
  }

  // --- rendering ----------------------------------------------------------
  // Drawn by Plotly (js/plot.js): one figure, two stacked y-axes on a shared
  // date x-axis, so zooming the top plot zooms the underwater panel with it.
  // Trace order matters — the HTML legend's data-trace indexes point at it.
  var MAIN_DOMAIN = [0.36, 1], UW_DOMAIN = [0, 0.25];
  var TARGET_POINTS = 2400;

  function signed(v, dp) { return (v >= 0 ? "+" : "") + fmt(v, dp); }

  function render(prices, selected, leverage, period, wk, mode, annMode, costs) {
    var levText = wk.label || (leverage + '×');
    var lo = period.from ? prices.findIndex(function (p) { return p.date >= period.from; }) : 0;
    if (lo < 0) lo = 0;
    lo = Math.max(lo, wk.startIdx);
    var hi = prices.length - 1;
    if (period.to) {
      for (var i = prices.length - 1; i >= 0; i--) { if (prices[i].date < period.to) { hi = i; break; } }
    }
    if (hi - lo < 3) return '<div class="panel"><div class="loading">Not enough history in this period.</div></div>';

    var built = buildSeries(prices, wk, leverage, lo, hi, costs);
    var pts = built.pts;
    var ruined = built.ruinIdx >= 0;
    var ruinDate = ruined ? pts[built.ruinIdx].date : null;

    var worst = pts[0], worstI = 0;
    pts.forEach(function (p, i6) { if (p.dd < worst.dd) { worst = p; worstI = i6; } });

    // The underwater panel and (in "total" mode) the equity lines share one
    // decimated index set, so hovering any date shows values from the same day.
    var keep = Plot.decimate(pts.length, TARGET_POINTS,
      [function (k) { return pts[k].eq; }, function (k) { return pts[k].hold; }, function (k) { return pts[k].dd; }],
      [worstI, built.ruinIdx, built.ruinIdx - 1]);
    var kd = keep.map(function (k) { return pts[k].date; });

    var legend = "", note = "", topTraces = null, topAxis = null, extraShapes = [], extraNotes = [];

    if (mode === "total") {
      legend = '<span data-trace="1"><i class="sw-strat"></i>Strategy at ' + levText + ' <b>' + (pts[pts.length - 1].eq > 0 ? fmt(pts[pts.length - 1].eq, 2) + '×' : '0 — wiped out') + '</b></span>'
        + '<span data-trace="0"><i class="sw-hold"></i>Buy &amp; hold (1×) <b>' + fmt(pts[pts.length - 1].hold, 2) + '×</b></span>'
        + '<span class="ch-note">log scale, rebased to 1× at ' + pts[0].date + '</span>';
      note = 'Total growth of £1, net of the costs configured on this tab. Buy &amp; hold is shown unleveraged and cost-free (dividends reinvested) for reference, so the gap is what the leverage, its costs, and the timing did together.';
      topTraces = function (t) {
        return [
          { x: kd, y: keep.map(function (k) { return pts[k].hold; }), type: "scatter", mode: "lines", name: "Buy & hold",
            line: { color: t.inkFaint, width: 1.2 }, hovertemplate: "Buy & hold %{y:,.2f}×<extra></extra>" },
          // Zero has no place on a log axis: after a wipeout the line stops and
          // the ruin marker says why.
          { x: kd, y: keep.map(function (k) { return pts[k].eq > 0 ? pts[k].eq : null; }), type: "scatter", mode: "lines", name: "Strategy",
            line: { color: t.long, width: 1.6 }, connectgaps: false, hovertemplate: "Strategy %{y:,.2f}×<extra></extra>" }
        ];
      };
      var eMin = Infinity, eMax = 0;
      pts.forEach(function (p) {
        if (p.eq > 0) { eMin = Math.min(eMin, p.eq); eMax = Math.max(eMax, p.eq); }
        eMin = Math.min(eMin, p.hold); eMax = Math.max(eMax, p.hold);
      });
      topAxis = Plot.logAxis(eMin, eMax, "×");
      if (ruined) {
        extraShapes.push({ type: "line", xref: "x", yref: "paper", x0: ruinDate, x1: ruinDate, y0: MAIN_DOMAIN[0], y1: MAIN_DOMAIN[1] });
        extraNotes.push({ text: "wiped out " + ruinDate, x: ruinDate, y: MAIN_DOMAIN[1] });
      }
    } else {
      var bars = annMode === "calendar" ? calendarYears(pts) : null;
      var line = annMode === "rolling10" ? rollingAnnualised(pts, 10)
               : annMode === "since" ? sinceStart(pts) : null;
      var vals = bars ? bars.map(function (b) { return b.value; }) : line.map(function (p) { return p.value; });
      if (!vals.length) return '<div class="panel"><div class="loading">Not enough history for this view.</div></div>';
      topAxis = { ticksuffix: "%", zeroline: true, zerolinewidth: 1.5 };
      if (bars) {
        var nPartial = bars.filter(function (b) { return b.partial; }).length;
        legend = '<span><i class="sw-pos"></i>Positive year</span><span><i class="sw-neg"></i>Negative year</span>'
          + (nPartial ? '<span class="ch-note">hatched = partial year at the window edge</span>' : '');
        note = 'Return for each calendar year, chained from the previous year&#8217;s close.'
          + (nPartial ? ' The first and last bars cover part of a year only &mdash; shown as the actual part-year return, not annualised.' : '');
        topTraces = function (t) {
          return [{
            type: "bar", name: "Calendar year",
            x: bars.map(function (b) { return b.label + "-07-01"; }),
            y: bars.map(function (b) { return b.value; }),
            width: bars.map(function () { return 0.8 * 365.25 * 864e5; }),
            marker: {
              color: bars.map(function (b) { return b.value >= 0 ? t.long : t.warn; }),
              opacity: bars.map(function (b) { return b.partial ? 0.55 : 1; }),
              pattern: { shape: bars.map(function (b) { return b.partial ? "/" : ""; }), fgcolor: t.card, size: 6 }
            },
            customdata: bars.map(function (b) { return b.label + (b.partial ? " (partial year)" : "") + ": " + signed(b.value, 1) + "%"; }),
            hovertemplate: "%{customdata}<extra></extra>"
          }];
        };
      } else {
        var lk = Plot.decimate(line.length, TARGET_POINTS, [function (k) { return line[k].value; }], []);
        var last2 = line[line.length - 1];
        legend = '<span data-trace="0"><i class="sw-strat"></i>'
          + (annMode === "rolling10" ? "Trailing 10-year annualised" : "Annualised since " + pts[0].date)
          + ' <b>' + (last2.value >= 0 ? "+" : "") + fmt(last2.value, 1) + '%</b> latest</span>';
        note = annMode === "rolling10"
          ? 'Annualised return over the preceding 10 years, at every date. The spread between its high and low is how much your <em>start date</em> mattered.'
          : 'Annualised return from the window start to each date &mdash; noisy early, converging on the headline CAGR.';
        topTraces = function (t) {
          return [{ type: "scatter", mode: "lines", name: annMode === "rolling10" ? "Trailing 10y" : "Since start",
            x: lk.map(function (k) { return line[k].date; }), y: lk.map(function (k) { return line[k].value; }),
            line: { color: t.long, width: 1.6 }, hovertemplate: "%{y:+.1f}% a year<extra></extra>" }];
        };
      }
    }

    // How long it stayed under water after the worst point.
    var recovered = null;
    for (var i8 = worstI; i8 < pts.length; i8++) { if (pts[i8].dd >= -0.0001) { recovered = pts[i8].date; break; } }
    var underNote = recovered
      ? 'Back to its previous peak on ' + recovered + ' — ' + fmt(yearsBetween(worst.date, recovered), 1) + ' years after the low.'
      : 'Never regained its previous peak within this period.';
    var worstText = 'worst ' + fmt(worst.dd * 100, 1) + '% · ' + worst.date;
    var spanYears = yearsBetween(pts[0].date, pts[pts.length - 1].date);
    var worstRight = worstI > pts.length * 0.7;

    var slot = Plot.slot({
      height: 400, group: "explorer", key: "explorer-perf",
      label: "Strategy performance with an underwater drawdown panel, " + pts[0].date + " to " + pts[pts.length - 1].date,
      build: function (t) {
        var data = topTraces(t);
        data.push({
          x: kd, y: keep.map(function (k) { return pts[k].dd * 100; }), yaxis: "y2", type: "scatter", mode: "lines", name: "Underwater",
          fill: "tozeroy", fillcolor: t.alpha(t.warn, 0.22), line: { color: t.alpha(t.warn, 0.55), width: 1 },
          hovertemplate: "Below peak %{y:.1f}%<extra></extra>"
        });
        data.push({
          x: [worst.date], y: [worst.dd * 100], yaxis: "y2", type: "scatter", mode: "markers", name: "Worst",
          marker: { color: t.warn, size: 7, line: { color: t.card, width: 1.5 } }, hoverinfo: "skip"
        });
        var notes = [
          { text: "Underwater — how far below the previous peak", x: 0, xref: "paper", y: UW_DOMAIN[1], yref: "paper", yanchor: "bottom", xanchor: "left", showarrow: false, font: { size: 10, color: t.inkFaint } },
          { text: worstText, x: worst.date, xref: "x", y: worst.dd * 100, yref: "y2", xanchor: worstRight ? "right" : "left", yanchor: "top", xshift: worstRight ? -8 : 8, showarrow: false, font: { size: 10, color: t.warn } }
        ].concat(extraNotes.map(function (n) {
          return { text: n.text, x: n.x, xref: "x", y: n.y, yref: "paper", xanchor: "left", yanchor: "top", xshift: 5, showarrow: false, font: { size: 10, color: t.warn } };
        }));
        var shapes = extraShapes.map(function (s) { return Object.assign({ line: { color: t.warn, width: 1, dash: "dot" } }, s); });
        return {
          data: data,
          layout: {
            margin: { l: 60, r: 14, t: spanYears > 2 ? 30 : 8, b: 28 },
            xaxis: Object.assign({ anchor: "y2" }, spanYears > 2 ? { rangeselector: Plot.rangeButtons(t) } : {}),
            yaxis: Object.assign(Plot.axisStyle(t), { domain: MAIN_DOMAIN }, topAxis, topAxis.zeroline ? { zerolinecolor: t.inkFaint } : {}),
            yaxis2: Object.assign(Plot.axisStyle(t), { domain: UW_DOMAIN, range: [-102, 2], tickvals: [-100, -50, 0], ticktext: ["−100%", "−50%", "0%"], zeroline: true, zerolinecolor: t.inkFaint, zerolinewidth: 1 }),
            annotations: notes, shapes: shapes
          }
        };
      }
    });

    return '<div class="panel">'
      + '<div class="detail-head"><h2>Performance (net of costs) &mdash; ' + selected.sma + 'd / ' + selected.buffer + '% at ' + levText + '</h2>'
      + '<div class="winbtns">'
      + '<button class="winbtn' + (mode === "total" ? " active" : "") + '" data-perf="total">Total return</button>'
      + '<button class="winbtn' + (mode === "ann" ? " active" : "") + '" data-perf="ann">Annualised</button>'
      + '</div></div>'
      + (mode === "ann"
        ? '<div class="winbtns sub"><button class="winbtn' + (annMode === "calendar" ? " active" : "") + '" data-ann="calendar">Calendar years</button>'
          + '<button class="winbtn' + (annMode === "rolling10" ? " active" : "") + '" data-ann="rolling10">Rolling 10y</button>'
          + '<button class="winbtn' + (annMode === "since" ? " active" : "") + '" data-ann="since">Since start</button></div>'
        : "")
      + slot
      + '<div class="ch-legend">' + legend + '</div>'
      + '<div class="toolsrow">' + note + ' <strong>' + underNote + '</strong></div>'
      + '</div>';
  }

  return { render: render };
})();
