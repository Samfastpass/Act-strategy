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

  // Drawn by Plotly (js/plot.js): exposure blocks on a hidden 0–1 base axis
  // under the log equity axis (y2 overlays y), and the exposure strip as its
  // own small panel (y3) on the same date axis, so zoom moves both. Trace
  // order is what the legend's data-trace indexes point at:
  // 0 full/sized blocks, 1 reduced blocks, 2 buy & hold, 3 strategy, 4 strip.
  var MAIN_DOMAIN = [0.27, 1], STRIP_DOMAIN = [0, 0.15];
  var TARGET_POINTS = 2400;

  // `years` = trailing window (null = all); `range` = { from, to } (to
  // exclusive, either may be null) taken from a chart zoom, which wins.
  function render(strategy, prices, equityCurve, walkResult, years, range) {
    if (!equityCurve.length) return '<div class="loading">Not enough history to chart.</div>';

    var lastDate = equityCurve[equityCurve.length - 1].date;
    var cutoff = windowStartDate(lastDate, years);

    // Align the price series to the equity curve's dates, then window both.
    var priceByDate = {};
    prices.forEach(function (p) { priceByDate[p.date] = p.close; });
    var stateByDate = {};
    prices.forEach(function (p, i) { stateByDate[p.date] = walkResult.state[i]; });

    var pts = equityCurve.filter(function (e) {
      if (range) return (!range.from || e.date >= range.from) && (!range.to || e.date < range.to);
      return cutoff == null || new Date(e.date) >= cutoff;
    });
    if (pts.length < 2) return '<div class="loading">Not enough history for this window.</div>';

    // Rebase both curves to 1.0 at the window start so they're comparable.
    var eq0 = pts[0].equity, px0 = priceByDate[pts[0].date];
    var series = pts.map(function (e) {
      return {
        date: e.date,
        strat: e.equity / eq0,
        hold: priceByDate[e.date] / px0,
        state: stateByDate[e.date] || 0
      };
    });

    var maxState = series.reduce(function (m, s) { return Math.max(m, s.state); }, strategy.outLeverage || 0) || 1;
    var isVolTgt = (strategy.sizing || {}).mode === "volTarget";
    // A strategy added from the Explorer can hold leverage below the SMA.
    var outLev = strategy.outLeverage || 0;
    var gated = strategy.leverage && strategy.leverage.gated;
    var base = strategy.leverage ? strategy.leverage.base : 1;

    // Block height carries the level as well as the colour (green vs amber is
    // a hard pair for red-green colour blindness): a vol-target position's
    // height is its size; a ratcheted-down position is half height.
    function fullLevel(i) {
      var s = series[i].state;
      if (!(s > 0)) return 0;
      if (isVolTgt) return s / maxState;
      return gated && s < base ? 0 : 1;
    }
    function reducedLevel(i) { var s = series[i].state; return !isVolTgt && gated && s > 0 && s < base ? 0.5 : 0; }
    function dateAt(i) { return series[i].date; }
    var last = series.length - 1;
    var fullSteps = Plot.steps(dateAt, fullLevel, 0, last);
    var downSteps = Plot.steps(dateAt, reducedLevel, 0, last);
    var stripSteps = Plot.steps(dateAt, function (i) { return series[i].state > 0 ? series[i].state : outLev; }, 0, last);

    var keep = Plot.decimate(series.length, TARGET_POINTS,
      [function (i) { return series[i].strat; }, function (i) { return series[i].hold; }], []);
    var kd = keep.map(dateAt);
    function heldText(i) {
      var s = series[i].state;
      if (!(s > 0)) return outLev ? "below the SMA, holding " + outLev + "×" : "out, in cash";
      return isVolTgt ? "holding " + Math.round(s * 100) + "%" : "in at " + fmt(s, 0) + "×";
    }

    var lastPt = series[last];
    var eMin = Infinity, eMax = 0;
    series.forEach(function (s) {
      if (s.strat > 0) { eMin = Math.min(eMin, s.strat); eMax = Math.max(eMax, s.strat); }
      eMin = Math.min(eMin, s.hold); eMax = Math.max(eMax, s.hold);
    });
    var expoLabel = isVolTgt
      ? "Exposure (0–" + Math.round(maxState * 100) + "%)"
      : "Exposure (0–" + fmt(maxState, 0) + "×)";

    var slot = Plot.slot({
      height: 330, key: "developed-equity", group: "developed", legendScope: ".chart-wrap",
      label: (strategy.rawName || strategy.name) + " strategy versus buy and hold, log scale, shaded by position size",
      build: function (t) {
        var stepLine = { width: 0, shape: "hv" };
        var data = [
          { x: fullSteps.x, y: fullSteps.y, type: "scatter", mode: "lines", name: "In", line: stepLine,
            fill: "tozeroy", fillcolor: t.alpha(t.long, 0.13), hoverinfo: "skip" },
          { x: downSteps.x, y: downSteps.y, type: "scatter", mode: "lines", name: "Ratcheted down", line: stepLine,
            fill: "tozeroy", fillcolor: t.alpha(t.flat, 0.2), hoverinfo: "skip" },
          { x: kd, y: keep.map(function (i) { return series[i].hold; }), yaxis: "y2", type: "scatter", mode: "lines", name: "Buy & hold",
            line: { color: t.inkFaint, width: 1.2 }, hovertemplate: "Buy & hold %{y:,.2f}×<extra></extra>" },
          { x: kd, y: keep.map(function (i) { return series[i].strat > 0 ? series[i].strat : null; }), yaxis: "y2", type: "scatter", mode: "lines", name: "Strategy",
            line: { color: t.long, width: 1.6 }, customdata: keep.map(heldText),
            hovertemplate: "Strategy %{y:,.2f}× · %{customdata}<extra></extra>" },
          { x: stripSteps.x, y: stripSteps.y, yaxis: "y3", type: "scatter", mode: "lines", name: "Exposure",
            line: { color: t.long, width: 1, shape: "hv" }, fill: "tozeroy", fillcolor: t.alpha(t.long, 0.6), hoverinfo: "skip" }
        ];
        var stripAxis = Plot.axisStyle(t);
        delete stripAxis.gridcolor;   // the strip has no grid
        return {
          data: data,
          layout: {
            margin: { l: 56, r: 14, t: 8, b: 28 },
            xaxis: { anchor: "y3" },
            yaxis: { domain: MAIN_DOMAIN, range: [0, 1], visible: false, fixedrange: true },
            yaxis2: Object.assign(Plot.axisStyle(t), { overlaying: "y", side: "left" }, Plot.logAxis(eMin, eMax, "×")),
            yaxis3: Object.assign(stripAxis, { domain: STRIP_DOMAIN, range: [0, maxState], showgrid: false, fixedrange: true,
              tickvals: [0, maxState], ticktext: ["0", isVolTgt ? Math.round(maxState * 100) + "%" : fmt(maxState, 0) + "×"] }),
            annotations: [{ text: expoLabel, x: 0, xref: "paper", y: STRIP_DOMAIN[1], yref: "paper", xanchor: "left", yanchor: "bottom", showarrow: false, font: { size: 10, color: t.inkFaint } }]
          }
        };
      }
    });

    return ''
      + '<div class="chart-wrap">'
      + slot
      + '<div class="ch-legend">'
      + '<span data-trace="3"><i class="sw-strat"></i>Strategy <b>' + fmt(lastPt.strat, 2) + '×</b></span>'
      + '<span data-trace="2"><i class="sw-hold"></i>Buy &amp; hold <b>' + fmt(lastPt.hold, 2) + '×</b></span>'
      + (isVolTgt
        ? '<span data-trace="0"><i class="sw-blk-full"></i>Invested &mdash; taller shading is a bigger position</span>'
        : (gated
          ? '<span data-trace="0"><i class="sw-blk-full"></i>In at ' + fmt(strategy.leverage.base, 0) + '× (full height)</span>'
            + '<span data-trace="1"><i class="sw-blk-reduced"></i>Ratcheted to ' + fmt(gated, 0) + '× (half height)</span>'
          : '<span data-trace="0"><i class="sw-blk-full"></i>In the market</span>'))
      + '<span class="ch-note">' + (outLev ? 'unshaded = below the SMA, held at ' + outLev + '&times;' : 'unshaded = out, in cash') + ' &middot; rebased to 1× at ' + series[0].date + ' &middot; log scale</span>'
      + '</div>'
      + '</div>';
  }

  return { render: render };
})();
