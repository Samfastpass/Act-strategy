// Price chart for the leverage explorer: price, its SMA, the symmetric buffer
// band, and — the point of the chart — when the strategy was in vs. out, drawn
// as background colour blocks.
//
// Distinct from js/chart.js, which plots *equity*. Here the y-axis is price, so
// you can see the crossings that generate the signal.
window.PriceChart = (function () {
  var fmt = window.App.fmt;

  var W = 760, H = 300, PAD_L = 52, PAD_R = 12, PAD_T = 14, PAD_B = 34;
  var PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_T - PAD_B;
  var MAX_POINTS = 1200;

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

    // y-range across price and both bands, log scale (a century of prices).
    var minV = Infinity, maxV = -Infinity;
    for (var k = lo; k <= hi; k++) {
      var c = prices[k].close;
      minV = Math.min(minV, c); maxV = Math.max(maxV, c);
      if (sma[k] != null) {
        minV = Math.min(minV, sma[k] * (1 - buffer));
        maxV = Math.max(maxV, sma[k] * (1 + buffer));
      }
    }
    var logLo = Math.log10(Math.max(minV, 1e-6)), logHi = Math.log10(maxV);
    if (logHi - logLo < 0.05) logHi = logLo + 0.05;

    var t0 = new Date(prices[lo].date).getTime();
    var t1 = new Date(prices[hi].date).getTime();
    var spanT = Math.max(1, t1 - t0);
    function x(d) { return PAD_L + ((new Date(d).getTime() - t0) / spanT) * PLOT_W; }
    function y(v) { return PAD_T + (1 - (Math.log10(Math.max(v, 1e-6)) - logLo) / (logHi - logLo)) * PLOT_H; }

    // In/out blocks: merge contiguous in-position runs into rects. Exact and
    // cheap — a century holds hundreds of episodes, not 24,800 — and never
    // downsampled, because the edges are exactly what the chart is for.
    // Level per day: 2 = full leverage, 1 = reduced (a vol-gated strategy
    // that has latched down), 0 = out. A run of equal, non-zero level becomes
    // one rect; the reduced level is drawn at half height (amber) so the
    // difference is not carried by colour alone.
    function level(j) {
      if (!(state[j] > 0)) return 0;
      return wk.gated && state[j] !== wk.high ? 1 : 2;
    }
    var blocks = "", runStart = null, runLevel = 0, inCount = 0, reducedCount = 0, episodes = 0;
    function flush(endIdx) {
      if (runStart === null || runLevel === 0) return;
      var x0 = x(prices[runStart].date), x1 = x(prices[endIdx].date);
      var h = runLevel === 2 ? PLOT_H : PLOT_H / 2;
      blocks += '<rect x="' + x0.toFixed(1) + '" y="' + (PAD_T + PLOT_H - h).toFixed(1) + '" width="' + Math.max(0.5, x1 - x0).toFixed(1)
        + '" height="' + h.toFixed(1) + '" class="' + (runLevel === 2 ? "pc-in" : "pc-down") + '"/>';
    }
    var prevLevel = 0;
    for (var j = lo; j <= hi; j++) {
      var lv = level(j);
      if (lv > 0) inCount++;
      if (lv === 1) reducedCount++;
      if (lv > 0 && prevLevel === 0) episodes++;
      if (lv !== runLevel) { flush(j - 1); runStart = j; runLevel = lv; }
      prevLevel = lv;
    }
    flush(hi);

    // Downsample the lines only.
    var stride = Math.max(1, Math.ceil((hi - lo + 1) / MAX_POINTS));
    function path(get) {
      var d = "", first = true;
      for (var i = lo; i <= hi; i += stride) {
        var v = get(i);
        if (v == null || !isFinite(v)) continue;
        d += (first ? "M" : "L") + x(prices[i].date).toFixed(1) + " " + y(v).toFixed(1);
        first = false;
      }
      return d;
    }
    // Band as a closed polygon: upper across, lower back.
    var bandPath = "";
    if (buffer > 0) {
      var up = [], dn = [];
      for (var b = lo; b <= hi; b += stride) {
        if (sma[b] == null) continue;
        up.push(x(prices[b].date).toFixed(1) + " " + y(sma[b] * (1 + buffer)).toFixed(1));
        dn.push(x(prices[b].date).toFixed(1) + " " + y(sma[b] * (1 - buffer)).toFixed(1));
      }
      if (up.length) bandPath = '<path d="M' + up.join("L") + "L" + dn.reverse().join("L") + 'Z" class="pc-band"/>';
    }

    // Gridlines: ~4 steps in log space, snapped to 1/2/5.
    function nice(v) {
      var p = Math.floor(Math.log10(v)), base = Math.pow(10, p), m = v / base;
      return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * base;
    }
    var grid = "", seen = {};
    for (var g = 0; g <= 4; g++) {
      var gv = nice(Math.pow(10, logLo + (logHi - logLo) * (g / 4)));
      if (seen[gv]) continue; seen[gv] = 1;
      var gy = y(gv);
      if (gy < PAD_T - 1 || gy > PAD_T + PLOT_H + 1) continue;
      grid += '<line x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '" class="ch-grid"/>'
        + '<text x="' + (PAD_L - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" class="ch-axis" text-anchor="end">' + fmt(gv, 0) + '</text>';
    }
    var xt = "";
    [lo, Math.floor((lo + hi) / 2), hi].forEach(function (i, n2) {
      xt += '<text x="' + x(prices[i].date).toFixed(1) + '" y="' + (PAD_T + PLOT_H + 16) + '" class="ch-axis" text-anchor="'
        + (n2 === 0 ? "start" : n2 === 2 ? "end" : "middle") + '">' + prices[i].date.slice(0, 7) + '</text>';
    });

    var pctIn = (100 * inCount / (hi - lo + 1));

    return '<div class="panel">'
      + '<div class="detail-head"><h2>' + smaLen + 'd SMA &middot; ' + bufferPct + '% buffer &middot; ' + (wk.label || leverage + 'x') + ' &mdash; '
      + prices[lo].date + ' to ' + prices[hi].date + '</h2></div>'
      + '<div class="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" preserveAspectRatio="xMidYMid meet" role="img"'
      + ' aria-label="S&amp;P price with ' + smaLen + ' day moving average, ' + bufferPct + ' percent buffer bands, and shaded in-position periods">'
      + blocks + grid + bandPath
      + '<path d="' + path(function (i) { return sma[i]; }) + '" class="pc-sma"/>'
      + '<path d="' + path(function (i) { return prices[i].close; }) + '" class="pc-price"/>'
      + xt
      + '</svg></div>'
      + '<div class="ch-legend">'
      + '<span><i class="sw-price"></i>Price</span>'
      + '<span><i class="sw-sma"></i>' + smaLen + 'd SMA</span>'
      + (buffer > 0 ? '<span><i class="sw-band"></i>&plusmn;' + bufferPct + '% buffer</span>' : '')
      + (wk.gated
        ? '<span><i class="sw-inblock"></i>In at ' + wk.high + '× (full height)</span><span><i class="sw-downblock"></i>Latched to ' + wk.low + '× (half height)</span>'
        : '<span><i class="sw-inblock"></i>In the market</span>')
      + '<span class="ch-note">unshaded = out, in cash &middot; log scale</span>'
      + '</div>'
      + '<div class="toolsrow">In the market ' + fmt(pctIn, 0) + '% of this period across ' + episodes + ' episodes'
      + (wk.gated ? ', ' + fmt(100 * reducedCount / Math.max(1, inCount), 0) + '% of that time at the reduced ' + wk.low + '×' : '') + '. '
      + 'The strategy buys when price closes above the upper band and sells when it closes below the lower one; '
      + 'between the bands it simply holds whatever it already had.</div>'
      + '</div>';
  }

  return { render: render };
})();
