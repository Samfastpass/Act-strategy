// Developed-tab equity chart: strategy vs. buy & hold, with an exposure
// strip underneath showing what the strategy was actually holding at the
// time. Drawn with Plotly via js/plot.js (hover, zoom, PNG export); the
// series are computed here, the colours come from the page's CSS variables.
//
// The y-axis is logarithmic. Over BTC's full history equity spans several
// orders of magnitude, and on a linear axis the first decade would be an
// indistinguishable flat line against the axis.
window.Chart = (function () {
  var fmt = window.App.fmt;
  var Plot = window.Plot;

  // Slice a date-keyed series to the trailing `years` (null = everything).
  function windowStartDate(lastDate, years) {
    if (years == null) return null;
    var d = new Date(lastDate);
    d.setFullYear(d.getFullYear() - years);
    return d;
  }

  // Drawn by Plotly (js/plot.js) as one figure on a shared date axis, so zoom
  // moves every panel together:
  //   main (y over a hidden 0–1 base y)  equity, log scale, exposure blocks behind
  //   y4                                  underwater: how far below the running peak
  //   y3                                  exposure strip
  // Trace order is what the legend's data-trace indexes point at:
  // 0 full/sized blocks, 1 reduced blocks, 2 buy & hold, 3 strategy,
  // 4 exposure strip, 5 underwater, 6 worst-point marker, 7 gross (if shown).
  var MAIN_DOMAIN = [0.47, 1], UW_DOMAIN = [0.19, 0.37], STRIP_DOMAIN = [0, 0.1];
  var TARGET_POINTS = 2400;

  function yearsBetween(a, b) { return (new Date(b) - new Date(a)) / (864e5 * 365.25); }

  // curves = {
  //   net:   equity net of costs (StrategyEngine.backtestEquityCurve with costs), or null
  //   gross: the same with no costs
  //   hold:  buy & hold at 1x with dividends reinvested, or null for price only
  // }   — all start on the walk's first day; the window rebases them to 1x.
  // `years` = trailing window (null = all); `range` = { from, to } (to
  // exclusive, either may be null) taken from a chart zoom, which wins.
  // `costNote` describes what "net" includes, for the legend.
  function render(strategy, prices, curves, walkResult, years, range, costNote) {
    var primary = curves.net || curves.gross;
    if (!primary.length) return '<div class="loading">Not enough history to chart.</div>';

    var lastDate = primary[primary.length - 1].date;
    var cutoff = windowStartDate(lastDate, years);

    // Align everything to the equity curve's dates, then window.
    var priceByDate = {}, stateByDate = {}, grossByDate = {}, holdByDate = {};
    // `walkResult.held` (optional) is the leverage actually held each day after
    // a cost cap; without one it's the walk's own state (or outLeverage while out).
    var heldByDate = {};
    prices.forEach(function (p, i) {
      priceByDate[p.date] = p.close; stateByDate[p.date] = walkResult.state[i];
      if (walkResult.held) heldByDate[p.date] = walkResult.held[i];
    });
    if (curves.net) curves.gross.forEach(function (e) { grossByDate[e.date] = e.equity; });
    if (curves.hold) curves.hold.forEach(function (e) { holdByDate[e.date] = e.equity; });

    var pts = primary.filter(function (e) {
      if (range) return (!range.from || e.date >= range.from) && (!range.to || e.date < range.to);
      return cutoff == null || new Date(e.date) >= cutoff;
    });
    if (pts.length < 2) return '<div class="loading">Not enough history for this window.</div>';

    // Rebase to 1.0 at the window start so the curves are comparable, and
    // measure drawdown from that start (the peak resets with the window).
    var d0 = pts[0].date;
    var eq0 = pts[0].equity, g0 = grossByDate[d0], h0 = curves.hold ? holdByDate[d0] : priceByDate[d0];
    var peak = 1;
    var series = pts.map(function (e) {
      var strat = eq0 > 0 ? e.equity / eq0 : 0;
      if (strat > peak) peak = strat;
      return {
        date: e.date, strat: strat,
        gross: curves.net && g0 > 0 ? grossByDate[e.date] / g0 : null,
        hold: (curves.hold ? holdByDate[e.date] : priceByDate[e.date]) / h0,
        dd: peak > 0 ? strat / peak - 1 : -1,
        state: stateByDate[e.date] || 0,
        held: walkResult.held ? heldByDate[e.date] || 0 : null
      };
    });

    var isVolTgt = (strategy.sizing || {}).mode === "volTarget";
    // A strategy added from the Explorer can hold leverage below the SMA.
    var outLev = strategy.outLeverage || 0;
    series.forEach(function (s) { if (s.held == null) s.held = s.state > 0 ? s.state : outLev; });
    var maxState = series.reduce(function (m, s) { return Math.max(m, s.state, s.held); }, outLev) || 1;
    var gated = strategy.leverage && strategy.leverage.gated;
    var base = strategy.leverage ? strategy.leverage.base : 1;

    // Block height carries the level as well as the colour (green vs amber is
    // a hard pair for red-green colour blindness): a vol-target position's
    // height is its size; a ratcheted-down position is half height.
    // "Reduced" = in, but holding less than the base leverage: a vol-gate
    // ratchet, or a cost cap trimming it.
    function fullLevel(i) {
      var s = series[i];
      if (!(s.state > 0)) return 0;
      if (isVolTgt) return s.held / maxState;
      return s.held < base ? 0 : 1;
    }
    function reducedLevel(i) { var s = series[i]; return !isVolTgt && s.state > 0 && s.held < base ? 0.5 : 0; }
    function dateAt(i) { return series[i].date; }
    var last = series.length - 1;
    var fullSteps = Plot.steps(dateAt, fullLevel, 0, last);
    var downSteps = Plot.steps(dateAt, reducedLevel, 0, last);
    var stripSteps = Plot.steps(dateAt, function (i) { return series[i].held; }, 0, last);

    var worstI = 0;
    series.forEach(function (s, i) { if (s.dd < series[worstI].dd) worstI = i; });
    var worst = series[worstI];
    var ruinI = series.findIndex(function (s) { return !(s.strat > 0); });

    // Min/max-preserving decimation; the worst day and a wipeout are always kept,
    // so the drawn trough is the labelled one.
    var keep = Plot.decimate(series.length, TARGET_POINTS,
      [function (i) { return series[i].strat; }, function (i) { return series[i].hold; }, function (i) { return series[i].dd; }],
      [worstI, ruinI, ruinI - 1]);
    var kd = keep.map(dateAt);
    function heldText(i) {
      var s = series[i];
      if (!(s.state > 0)) return outLev ? "below the SMA, holding " + s.held + "×" : "out, in cash";
      if (isVolTgt) return "holding " + Math.round(s.held * 100) + "%";
      return "in at " + fmt(s.held, 0) + "×" + (s.held < s.state ? " (cost cap)" : "");
    }

    var lastPt = series[last];
    var eMin = Infinity, eMax = 0;
    series.forEach(function (s) {
      [s.strat, s.hold, s.gross].forEach(function (v) { if (v > 0) { eMin = Math.min(eMin, v); eMax = Math.max(eMax, v); } });
    });
    var expoLabel = isVolTgt
      ? "Exposure (0–" + Math.round(maxState * 100) + "%)"
      : "Exposure (0–" + fmt(maxState, 0) + "×)";
    var worstText = "worst " + fmt(worst.dd * 100, 1) + "% · " + worst.date;
    var worstRight = worstI > series.length * 0.7;
    var recovered = null;
    for (var r = worstI; r < series.length; r++) { if (series[r].dd >= -0.0001) { recovered = series[r].date; break; } }
    var netLabel = curves.net ? "Strategy, net of costs" : "Strategy (gross — no cost data for this asset)";

    var slot = Plot.slot({
      height: 470, key: "developed-equity", group: "developed", legendScope: ".chart-wrap",
      label: (strategy.rawName || strategy.name) + " strategy versus buy and hold, log scale, with drawdown and exposure panels",
      build: function (t) {
        var stepLine = { width: 0, shape: "hv" };
        var data = [
          { x: fullSteps.x, y: fullSteps.y, type: "scatter", mode: "lines", name: "In", line: stepLine,
            fill: "tozeroy", fillcolor: t.alpha(t.long, 0.13), hoverinfo: "skip" },
          { x: downSteps.x, y: downSteps.y, type: "scatter", mode: "lines", name: "Ratcheted down", line: stepLine,
            fill: "tozeroy", fillcolor: t.alpha(t.flat, 0.2), hoverinfo: "skip" },
          { x: kd, y: keep.map(function (i) { return series[i].hold; }), yaxis: "y2", type: "scatter", mode: "lines", name: "Buy & hold",
            line: { color: t.inkFaint, width: 1.2 }, hovertemplate: "Buy & hold %{y:,.2f}×<extra></extra>" },
          // Zero has no place on a log axis: after a wipeout the line stops.
          { x: kd, y: keep.map(function (i) { return series[i].strat > 0 ? series[i].strat : null; }), yaxis: "y2", type: "scatter", mode: "lines", name: "Strategy",
            line: { color: t.long, width: 1.6 }, customdata: keep.map(heldText),
            hovertemplate: (curves.net ? "Net" : "Strategy") + " %{y:,.2f}× · %{customdata}<extra></extra>" },
          { x: stripSteps.x, y: stripSteps.y, yaxis: "y3", type: "scatter", mode: "lines", name: "Exposure",
            line: { color: t.long, width: 1, shape: "hv" }, fill: "tozeroy", fillcolor: t.alpha(t.long, 0.6), hoverinfo: "skip" },
          { x: kd, y: keep.map(function (i) { return series[i].dd * 100; }), yaxis: "y4", type: "scatter", mode: "lines", name: "Underwater",
            fill: "tozeroy", fillcolor: t.alpha(t.warn, 0.22), line: { color: t.alpha(t.warn, 0.55), width: 1 },
            hovertemplate: "Below peak %{y:.1f}%<extra></extra>" },
          { x: [worst.date], y: [worst.dd * 100], yaxis: "y4", type: "scatter", mode: "markers", name: "Worst",
            marker: { color: t.warn, size: 7, line: { color: t.card, width: 1.5 } }, hoverinfo: "skip" }
        ];
        if (curves.net) data.push({ x: kd, y: keep.map(function (i) { return series[i].gross; }), yaxis: "y2", type: "scatter", mode: "lines", name: "Gross",
          line: { color: t.long, width: 1, dash: "3px,3px" }, opacity: 0.55, hovertemplate: "Gross %{y:,.2f}×<extra></extra>" });
        var stripAxis = Plot.axisStyle(t);
        delete stripAxis.gridcolor;   // the strip has no grid
        var caption = function (text, y) {
          return { text: text, x: 0, xref: "paper", y: y, yref: "paper", xanchor: "left", yanchor: "bottom", showarrow: false, font: { size: 10, color: t.inkFaint } };
        };
        var shapes = [], notes = [
          caption(expoLabel, STRIP_DOMAIN[1]),
          caption("Underwater — how far below the previous peak", UW_DOMAIN[1]),
          { text: worstText, x: worst.date, xref: "x", y: worst.dd * 100, yref: "y4", xanchor: worstRight ? "right" : "left", yanchor: "top", xshift: worstRight ? -8 : 8, showarrow: false, font: { size: 10, color: t.warn } }
        ];
        if (ruinI > 0) {
          shapes.push({ type: "line", xref: "x", yref: "paper", x0: series[ruinI].date, x1: series[ruinI].date, y0: MAIN_DOMAIN[0], y1: MAIN_DOMAIN[1], line: { color: t.warn, width: 1, dash: "dot" } });
          notes.push({ text: "wiped out " + series[ruinI].date, x: series[ruinI].date, xref: "x", y: MAIN_DOMAIN[1], yref: "paper", xanchor: "left", yanchor: "top", xshift: 5, showarrow: false, font: { size: 10, color: t.warn } });
        }
        return {
          data: data,
          layout: {
            margin: { l: 60, r: 14, t: 8, b: 28 },
            xaxis: { anchor: "y3" },
            yaxis: { domain: MAIN_DOMAIN, range: [0, 1], visible: false, fixedrange: true },
            yaxis2: Object.assign(Plot.axisStyle(t), { overlaying: "y", side: "left" }, Plot.logAxis(eMin, eMax, "×")),
            yaxis3: Object.assign(stripAxis, { domain: STRIP_DOMAIN, range: [0, maxState], showgrid: false, fixedrange: true,
              tickvals: [0, maxState], ticktext: ["0", isVolTgt ? Math.round(maxState * 100) + "%" : fmt(maxState, 0) + "×"] }),
            yaxis4: Object.assign(Plot.axisStyle(t), { domain: UW_DOMAIN, range: [-102, 2], tickvals: [-100, -50, 0], ticktext: ["−100%", "−50%", "0%"],
              zeroline: true, zerolinecolor: t.inkFaint, zerolinewidth: 1 }),
            annotations: notes, shapes: shapes
          }
        };
      }
    });

    return ''
      + '<div class="chart-wrap">'
      + slot
      + '<div class="ch-legend">'
      + '<span data-trace="3"><i class="sw-strat"></i>' + netLabel + ' <b>' + (lastPt.strat > 0 ? fmt(lastPt.strat, 2) + '×' : '0 — wiped out') + '</b></span>'
      + (curves.net ? '<span data-trace="7"><i class="sw-gross"></i>Gross, before costs <b>' + fmt(lastPt.gross, 2) + '×</b></span>' : '')
      + '<span data-trace="2"><i class="sw-hold"></i>Buy &amp; hold (1×' + (curves.hold ? ', dividends reinvested' : '') + ') <b>' + fmt(lastPt.hold, 2) + '×</b></span>'
      + (isVolTgt
        ? '<span data-trace="0"><i class="sw-blk-full"></i>Invested &mdash; taller shading is a bigger position</span>'
        : (gated
          ? '<span data-trace="0"><i class="sw-blk-full"></i>In at ' + fmt(strategy.leverage.base, 0) + '× (full height)</span>'
            + '<span data-trace="1"><i class="sw-blk-reduced"></i>' + (strategy.costCap > 0 ? 'Reduced &mdash; vol ratchet or cost cap' : 'Ratcheted to ' + fmt(gated, 0) + '×') + ' (half height)</span>'
          : '<span data-trace="0"><i class="sw-blk-full"></i>In the market</span>'
            + (strategy.costCap > 0 ? '<span data-trace="1"><i class="sw-blk-reduced"></i>Cut by the cost cap (half height)</span>' : '')))
      + '<span class="ch-note">' + (outLev ? 'unshaded = below the SMA, held at ' + outLev + '&times;' : 'unshaded = out, in cash') + ' &middot; rebased to 1× at ' + series[0].date + ' &middot; log scale</span>'
      + '</div>'
      + '<div class="toolsrow">'
      + (curves.net ? 'Net of ' + (costNote || 'fees, financing and slippage') + ' &mdash; the same cost model as the Strategy Explorer and Evaluator. Buy &amp; hold is cost-free. ' : '')
      + 'Worst drawdown in this window <strong>' + fmt(worst.dd * 100, 1) + '%</strong> (' + worst.date + '); '
      + (recovered ? 'back to its previous peak on ' + recovered + ', ' + fmt(yearsBetween(worst.date, recovered), 1) + ' years after the low.'
                   : 'not back to its previous peak by the end of this window.')
      + '</div>'
      + '</div>';
  }

  return { render: render };
})();
