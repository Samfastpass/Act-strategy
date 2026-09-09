// Hand-rolled SVG equity chart: strategy vs. buy & hold, with an exposure
// strip underneath showing what the strategy was actually holding at the
// time. No charting library — keeps the zero-build-step setup, and lets
// the chart inherit the page's CSS variables in both themes.
//
// The y-axis is logarithmic. Over BTC's full history equity spans several
// orders of magnitude, and on a linear axis the first decade would be an
// indistinguishable flat line against the axis.
window.Chart = (function () {
  var fmt = window.App.fmt;

  var W = 720, H = 260, PAD_L = 46, PAD_R = 12, PAD_T = 12, PAD_B = 46;
  var STRIP_H = 22, STRIP_GAP = 8;
  var PLOT_W = W - PAD_L - PAD_R;
  var PLOT_H = H - PAD_T - PAD_B;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Slice a date-keyed series to the trailing `years` (null = everything).
  function windowStartDate(lastDate, years) {
    if (years == null) return null;
    var d = new Date(lastDate);
    d.setFullYear(d.getFullYear() - years);
    return d;
  }

  function render(strategy, prices, equityCurve, walkResult, years) {
    if (!equityCurve.length) return '<div class="loading">Not enough history to chart.</div>';

    var lastDate = equityCurve[equityCurve.length - 1].date;
    var cutoff = windowStartDate(lastDate, years);

    // Align the price series to the equity curve's dates, then window both.
    var priceByDate = {};
    prices.forEach(function (p) { priceByDate[p.date] = p.close; });
    var stateByDate = {};
    prices.forEach(function (p, i) { stateByDate[p.date] = walkResult.state[i]; });

    var pts = equityCurve.filter(function (e) {
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

    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) {
      lo = Math.min(lo, s.strat, s.hold);
      hi = Math.max(hi, s.strat, s.hold);
    });
    lo = Math.max(lo, 1e-6);
    var logLo = Math.log10(lo), logHi = Math.log10(hi);
    if (logHi - logLo < 0.05) { logHi = logLo + 0.05; } // guard a flat window

    var t0 = new Date(series[0].date).getTime();
    var t1 = new Date(series[series.length - 1].date).getTime();
    var spanT = Math.max(1, t1 - t0);

    function x(dateStr) { return PAD_L + ((new Date(dateStr).getTime() - t0) / spanT) * PLOT_W; }
    function y(v) { return PAD_T + (1 - (Math.log10(Math.max(v, 1e-6)) - logLo) / (logHi - logLo)) * PLOT_H; }

    function path(key) {
      var d = "";
      for (var i = 0; i < series.length; i++) {
        d += (i ? "L" : "M") + x(series[i].date).toFixed(1) + " " + y(series[i][key]).toFixed(1);
      }
      return d;
    }

    // Gridlines evenly spaced in log space. Decade-only ticks would draw a
    // single line on a 1x–3x window and a dozen on BTC's full history, so
    // pick ~4 steps across whatever range this window actually spans and
    // snap each to a readable 1/2/5 value.
    function niceLog(v) {
      var p = Math.floor(Math.log10(v));
      var base = Math.pow(10, p);
      var m = v / base;
      var snapped = m < 1.5 ? 1 : (m < 3.5 ? 2 : (m < 7.5 ? 5 : 10));
      return snapped * base;
    }
    var gridlines = "";
    var seen = {};
    for (var g = 0; g <= 4; g++) {
      var gv = niceLog(Math.pow(10, logLo + (logHi - logLo) * (g / 4)));
      if (seen[gv] || gv <= 0) continue;
      seen[gv] = true;
      var gy = y(gv);
      if (gy < PAD_T - 1 || gy > PAD_T + PLOT_H + 1) continue;
      var label = gv >= 1 ? fmt(gv, 0) : gv.toPrecision(2);
      gridlines += '<line x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '" class="ch-grid"/>'
        + '<text x="' + (PAD_L - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" class="ch-axis" text-anchor="end">'
        + label + '×</text>';
    }

    // X labels: first, middle, last.
    var xticks = "";
    [0, Math.floor(series.length / 2), series.length - 1].forEach(function (i, k) {
      var s = series[i];
      var anchor = k === 0 ? "start" : (k === 2 ? "end" : "middle");
      xticks += '<text x="' + x(s.date).toFixed(1) + '" y="' + (PAD_T + PLOT_H + 16) + '" class="ch-axis" text-anchor="' + anchor + '">' + s.date.slice(0, 7) + '</text>';
    });

    // Exposure strip: one bar per day, height scaled to the window's max
    // exposure so it reads for both 0/3/5x leverage and 0–100% sizing.
    var maxState = series.reduce(function (m, s) { return Math.max(m, s.state); }, 0) || 1;
    var stripY = PAD_T + PLOT_H + STRIP_GAP + 14;
    var barW = Math.max(0.6, PLOT_W / series.length);
    var bars = "";
    series.forEach(function (s) {
      if (s.state <= 0) return;
      var h = (s.state / maxState) * STRIP_H;
      bars += '<rect x="' + x(s.date).toFixed(1) + '" y="' + (stripY + STRIP_H - h).toFixed(1)
        + '" width="' + barW.toFixed(2) + '" height="' + h.toFixed(1) + '" class="ch-expo"/>';
    });

    var last = series[series.length - 1];
    var isVolTarget = (strategy.sizing || {}).mode === "volTarget";
    var expoLabel = isVolTarget
      ? "Exposure (0–" + Math.round(maxState * 100) + "%)"
      : "Exposure (0–" + fmt(maxState, 0) + "×)";

    return ''
      + '<div class="chart-wrap">'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" preserveAspectRatio="xMidYMid meet" role="img" '
      + 'aria-label="' + esc(strategy.name) + ' strategy versus buy and hold, log scale">'
      + gridlines
      + '<path d="' + path("hold") + '" class="ch-hold"/>'
      + '<path d="' + path("strat") + '" class="ch-strat"/>'
      + xticks
      + '<text x="' + PAD_L + '" y="' + (stripY - 4) + '" class="ch-axis">' + expoLabel + '</text>'
      + '<rect x="' + PAD_L + '" y="' + stripY + '" width="' + PLOT_W + '" height="' + STRIP_H + '" class="ch-strip-bg"/>'
      + bars
      + '</svg>'
      + '<div class="ch-legend">'
      + '<span><i class="sw-strat"></i>Strategy <b>' + fmt(last.strat, 2) + '×</b></span>'
      + '<span><i class="sw-hold"></i>Buy &amp; hold <b>' + fmt(last.hold, 2) + '×</b></span>'
      + '<span class="ch-note">rebased to 1× at ' + series[0].date + ' · log scale</span>'
      + '</div>'
      + '</div>';
  }

  return { render: render };
})();
