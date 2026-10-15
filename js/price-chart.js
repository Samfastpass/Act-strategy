// Price chart for the leverage explorer: price, its SMA, the symmetric buffer
// band, and — the point of the chart — when the strategy was in vs. out, drawn
// as background colour blocks.
//
// Distinct from js/chart.js, which plots *equity*. Here the y-axis is price, so
// you can see the crossings that generate the signal.
window.PriceChart = (function () {
  var fmt = window.App.fmt;
  var Plot = window.Plot;

  // Drawn by Plotly (js/plot.js). The in/out blocks sit on a hidden 0–1 base
  // axis UNDER the price axis (y2 overlays y), so they shade behind the lines
  // without stealing hover. Trace order is what the legend's data-trace
  // indexes point at: 0 full blocks, 1 reduced blocks, 2–3 band, 4 SMA, 5 price.
  var TARGET_POINTS = 2400;

  function render(prices, selected, leverage, period, wk) {
    var smaLen = selected.sma, bufferPct = selected.buffer;
    var buffer = bufferPct / 100;

    var lo = period.from ? prices.findIndex(function (p) { return p.date >= period.from; }) : 0;
    if (lo < 0) lo = 0;
    lo = Math.max(lo, wk.startIdx);
    var hi = prices.length - 1;
    if (period.to) {
      for (var i = prices.length - 1; i >= 0; i--) { if (prices[i].date < period.to) { hi = i; break; } }
    }
    if (hi - lo < 2) return '<div class="panel"><div class="loading">Not enough history in this period.</div></div>';

    var sma = wk.sma, state = wk.state; // 0/1 for a binary walk (at 1x); real leverage multiples when wk.gated

    // Level per day: 2 = full leverage, 1 = reduced (a vol-gated strategy
    // that has latched down), 0 = out. The reduced level is drawn at half
    // height (amber) so the difference is not carried by colour alone.
    function level(j) {
      if (!(state[j] > 0)) return 0;
      return wk.gated && state[j] !== wk.high ? 1 : 2;
    }
    var inCount = 0, reducedCount = 0, episodes = 0, prevLevel = 0;
    for (var j = lo; j <= hi; j++) {
      var lv = level(j);
      if (lv > 0) inCount++;
      if (lv === 1) reducedCount++;
      if (lv > 0 && prevLevel === 0) episodes++;
      prevLevel = lv;
    }
    function dateAt(k) { return prices[k].date; }
    // Exact at every edge — never decimated, the edges are what the chart is for.
    var fullSteps = Plot.steps(dateAt, function (k) { return level(k) === 2 ? 1 : 0; }, lo, hi);
    var downSteps = Plot.steps(dateAt, function (k) { return level(k) === 1 ? 0.5 : 0; }, lo, hi);

    // What is held on a given day, for the hover readout.
    function heldText(k) {
      if (!(state[k] > 0)) return wk.out > 0 ? "below the SMA, holding " + wk.out + "×" : "out, in cash";
      return "in at " + (wk.gated ? state[k] : leverage) + "×";
    }

    var n = hi - lo + 1;
    var keep = Plot.decimate(n, TARGET_POINTS,
      [function (k) { return prices[lo + k].close; }, function (k) { return sma[lo + k]; }], [])
      .map(function (k) { return lo + k; });
    var kd = keep.map(dateAt);
    function smaAt(k, mult) { return sma[k] == null ? null : sma[k] * mult; }

    var minV = Infinity, maxV = 0;
    for (var m = lo; m <= hi; m++) {
      minV = Math.min(minV, prices[m].close); maxV = Math.max(maxV, prices[m].close);
      if (sma[m] != null) { minV = Math.min(minV, sma[m] * (1 - buffer)); maxV = Math.max(maxV, sma[m] * (1 + buffer)); }
    }
    var pctIn = (100 * inCount / (hi - lo + 1));
    var spanYears = (new Date(prices[hi].date) - new Date(prices[lo].date)) / (864e5 * 365.25);

    var slot = Plot.slot({
      height: 330, group: "explorer", key: "explorer-price",
      label: "Price with " + smaLen + " day moving average, " + bufferPct + " percent buffer bands, and shaded in-position periods, " + prices[lo].date + " to " + prices[hi].date,
      build: function (t) {
        var stepLine = { width: 0, shape: "hv" };
        var data = [
          { x: fullSteps.x, y: fullSteps.y, type: "scatter", mode: "lines", name: "In", line: stepLine,
            fill: "tozeroy", fillcolor: t.alpha(t.long, 0.13), hoverinfo: "skip" },
          { x: downSteps.x, y: downSteps.y, type: "scatter", mode: "lines", name: "Latched down", line: stepLine,
            fill: "tozeroy", fillcolor: t.alpha(t.flat, 0.22), hoverinfo: "skip" },
          { x: kd, y: keep.map(function (k) { return smaAt(k, 1 + buffer); }), yaxis: "y2", type: "scatter", mode: "lines", name: "Band",
            line: { width: 0 }, hoverinfo: "skip", visible: buffer > 0 },
          { x: kd, y: keep.map(function (k) { return smaAt(k, 1 - buffer); }), yaxis: "y2", type: "scatter", mode: "lines", name: "Band",
            line: { width: 0 }, fill: "tonexty", fillcolor: t.alpha(t.inkFaint, 0.16), hoverinfo: "skip", visible: buffer > 0 },
          { x: kd, y: keep.map(function (k) { return sma[k]; }), yaxis: "y2", type: "scatter", mode: "lines", name: smaLen + "d SMA",
            line: { color: t.inkFaint, width: 1.3 }, hovertemplate: smaLen + "d SMA %{y:,.2f}<extra></extra>" },
          { x: kd, y: keep.map(function (k) { return prices[k].close; }), yaxis: "y2", type: "scatter", mode: "lines", name: "Price",
            line: { color: t.ink, width: 1.4 }, customdata: keep.map(heldText),
            hovertemplate: "Price %{y:,.2f} · %{customdata}<extra></extra>" }
        ];
        return {
          data: data,
          layout: {
            margin: { l: 60, r: 14, t: spanYears > 2 ? 30 : 8, b: 28 },
            xaxis: spanYears > 2 ? { rangeselector: Plot.rangeButtons(t) } : {},
            yaxis: { range: [0, 1], visible: false, fixedrange: true },
            yaxis2: Object.assign(Plot.axisStyle(t), { overlaying: "y", side: "left" }, Plot.logAxis(minV, maxV))
          }
        };
      }
    });

    return '<div class="panel">'
      + '<div class="detail-head"><h2>' + smaLen + 'd SMA &middot; ' + bufferPct + '% buffer &middot; ' + (wk.label || leverage + 'x') + ' &mdash; '
      + prices[lo].date + ' to ' + prices[hi].date + '</h2></div>'
      + slot
      + '<div class="ch-legend">'
      + '<span data-trace="5"><i class="sw-price"></i>Price</span>'
      + '<span data-trace="4"><i class="sw-sma"></i>' + smaLen + 'd SMA</span>'
      + (buffer > 0 ? '<span data-trace="2,3"><i class="sw-band"></i>&plusmn;' + bufferPct + '% buffer</span>' : '')
      + (wk.gated
        ? '<span data-trace="0"><i class="sw-inblock"></i>In at ' + wk.high + '× (full height)</span><span data-trace="1"><i class="sw-downblock"></i>Latched to ' + wk.low + '× (half height)</span>'
        : '<span data-trace="0"><i class="sw-inblock"></i>In the market</span>')
      + '<span class="ch-note">' + (wk.out > 0 ? 'unshaded = below the SMA, held at ' + wk.out + '&times;' : 'unshaded = out, in cash') + ' &middot; log scale</span>'
      + '</div>'
      + '<div class="toolsrow">' + (wk.out > 0 ? 'Above the trend signal' : 'In the market') + ' ' + fmt(pctIn, 0) + '% of this period across ' + episodes + ' episodes'
      + (wk.gated ? ', ' + fmt(100 * reducedCount / Math.max(1, inCount), 0) + '% of that time at the reduced ' + wk.low + '×' : '') + '. '
      + 'The strategy buys when price closes above the upper band and sells when it closes below the lower one; '
      + 'between the bands it simply holds whatever it already had.</div>'
      + '</div>';
  }

  return { render: render };
})();
