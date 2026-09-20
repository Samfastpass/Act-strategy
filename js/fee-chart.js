// Fee headline + history for the Strategy Explorer's costs panel.
//
// The headline is the all-in annual cost of holding the selected leverage at
// today's rates — the number a platform's "ongoing charge" leaves out, because
// financing floats with interest rates. The chart shows that same cost month
// by month over the selected period: fees are flat, financing rises and falls
// with the reference rate, so the gap between "what the platform quotes" and
// "what it actually costs" is visible across rate regimes.
//
// Purely presentational: every number comes from CostModel.annualDrag on the
// same product fields and reference series the equity maths uses, so the chart
// cannot disagree with the matrix.
window.FeeChart = (function () {
  var fmt = window.App.fmt;

  var W = 760, H = 250, PAD_L = 46, PAD_R = 78, PAD_T = 12, PAD_B = 28;
  var PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_T - PAD_B;

  function monthList(fromDate, toDate) {
    var out = [];
    var y = Number(fromDate.slice(0, 4)), m = Number(fromDate.slice(5, 7));
    var ey = Number(toDate.slice(0, 4)), em = Number(toDate.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) {
      out.push((y < 1000 ? "0" + y : String(y)) + "-" + (m < 10 ? "0" + m : m));
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // One series per leverage: [{ m, fees, fin, total, div }] in % a year.
  function seriesFor(lev, months, o) {
    return months.map(function (m) {
      var rate = o.rateFn ? o.rateFn(m + "-15") : 0;
      var d = window.CostModel.annualDrag(lev.exposure, rate, lev.product);
      return { m: m, fees: d.chargesPct, fin: d.financingPct, total: d.totalPct,
               div: (o.divFn ? o.divFn(m + "-15") : 0) * lev.exposure };
    });
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  // o: {
  //   primary:   { exposure, product }        product = { mgmtFeePct, dailySwapRatePct, fundingSpreadPct } (spread incl. basis)
  //   secondary: same shape or null           the reduced leverage of a vol-gated strategy
  //   rateFn, rateName, rateNow, rateNowMonth, rateEarliest   reference-rate lookup (pct) and its provenance
  //   divFn: (dateStr) -> yield pct or null
  //   from, to: date strings bounding the chart
  //   productName, quotedCharge: display strings / number (platform "ongoing charge" = fee + swap x 360)
  // }
  function render(o) {
    var L = o.primary.exposure;
    var months = monthList(o.from, o.to);
    if (months.length < 2) return "";
    var prim = seriesFor(o.primary, months, o);
    var sec = o.secondary ? seriesFor(o.secondary, months, o) : null;

    var nowDrag = window.CostModel.annualDrag(L, o.rateNow || 0, o.primary.product);
    var avg = prim.reduce(function (a, p) { return a + p.total; }, 0) / prim.length;
    var peak = prim.reduce(function (a, p) { return p.total > a.total ? p : a; }, prim[0]);

    function tile(label, val, sub) {
      return '<div class="stat"><div class="k">' + label + '</div><div class="v">' + val + '</div>'
        + (sub ? '<div class="k" style="margin:3px 0 0;">' + sub + '</div>' : '') + '</div>';
    }
    var borrowed = Math.max(0, L - 1);
    var tiles = '<div class="statrow fee-tiles" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));">'
      + tile("All-in cost now", fmt(nowDrag.totalPct, 1) + "%/yr",
             L > 1 && o.rateName ? o.rateName + " " + fmt(o.rateNow || 0, 2) + "% (" + (o.rateNowMonth || "latest") + ")" : "fees only")
      + tile("of which fees", fmt(nowDrag.chargesPct, 2) + "%", "management + swap, flat")
      + tile("of which financing", fmt(nowDrag.financingPct, 2) + "%",
             borrowed > 0 ? fmt(borrowed, 0) + " borrowed × (rate + spread)" : "nothing borrowed at 1×")
      + tile("Average, chart period", fmt(avg, 1) + "%/yr", months[0] + " → " + months[months.length - 1])
      + tile("Peak month", fmt(peak.total, 1) + "%/yr", peak.m)
      + '</div>';

    var quoted = '';
    if (o.quotedCharge != null && borrowed > 0) {
      quoted = '<div class="toolsrow">Platforms typically quote just the fee line — <strong>' + fmt(o.quotedCharge, 2) + '%</strong> for ' + (o.productName || "this product")
        + ' — which leaves out the financing. Today that hides <strong>' + fmt(nowDrag.financingPct, 1) + '%</strong> a year.</div>';
    }

    // ---- chart ----
    var maxY = 0;
    prim.forEach(function (p) { maxY = Math.max(maxY, p.total, p.div); });
    if (sec) sec.forEach(function (p) { maxY = Math.max(maxY, p.total); });
    var top = niceMax(maxY * 1.05);
    var n = prim.length;
    function x(i) { return PAD_L + (i / (n - 1)) * PLOT_W; }
    function y(v) { return PAD_T + (1 - v / top) * PLOT_H; }

    function line(arr, get) {
      var d = "";
      for (var i = 0; i < arr.length; i++) d += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(get(arr[i])).toFixed(1);
      return d;
    }
    function area(arr, lowGet, highGet) {
      var up = "", dn = [];
      for (var i = 0; i < arr.length; i++) {
        up += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(highGet(arr[i])).toFixed(1);
        dn.push(x(i).toFixed(1) + " " + y(lowGet(arr[i])).toFixed(1));
      }
      return up + "L" + dn.reverse().join("L") + "Z";
    }

    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var gv = top * g / 4, gy = y(gv);
      grid += '<line x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '" class="ch-grid"/>'
        + '<text x="' + (PAD_L - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" class="ch-axis" text-anchor="end">' + fmt(gv, top < 10 ? 1 : 0) + '%</text>';
    }
    var xt = "";
    [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, k) {
      xt += '<text x="' + x(i).toFixed(1) + '" y="' + (PAD_T + PLOT_H + 16) + '" class="ch-axis" text-anchor="' + (k === 0 ? "start" : k === 2 ? "end" : "middle") + '">' + months[i].slice(0, 4) + '</text>';
    });

    // Months before the reference series begins hold its first value — say so,
    // don't let a flat stretch look like data.
    var heldRect = "";
    if (o.rateEarliest && months[0] < o.rateEarliest && L > 1) {
      var k2 = months.findIndex(function (m) { return m >= o.rateEarliest; });
      if (k2 < 0) k2 = n - 1;
      if (k2 > 0) heldRect = '<rect x="' + PAD_L + '" y="' + PAD_T + '" width="' + (x(k2) - PAD_L).toFixed(1) + '" height="' + PLOT_H + '" class="fc-held"/>'
        + '<text x="' + (PAD_L + 4) + '" y="' + (PAD_T + 11) + '" class="ch-axis">rate held at ' + o.rateEarliest.slice(0, 4) + ' level</text>';
    }

    var last = n - 1;
    function endLabel(v, text, cls, dy) {
      return '<text x="' + (W - PAD_R + 5) + '" y="' + (y(v) + 3.5 + (dy || 0)).toFixed(1) + '" class="ch-axis ' + (cls || "") + '">' + text + '</text>';
    }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" preserveAspectRatio="xMidYMid meet" role="img"'
      + ' aria-label="Approximate all-in annual cost of ' + L + ' times leverage by month, from ' + months[0] + ' to ' + months[last]
      + ': now ' + fmt(nowDrag.totalPct, 1) + ' percent a year, average ' + fmt(avg, 1) + ', peak ' + fmt(peak.total, 1) + ' in ' + peak.m + '">'
      + grid + heldRect
      + '<path d="' + area(prim, function () { return 0; }, function (p) { return p.fees; }) + '" class="fc-fees"/>'
      + '<path d="' + area(prim, function (p) { return p.fees; }, function (p) { return p.total; }) + '" class="fc-fin"/>'
      + '<path d="' + line(prim, function (p) { return p.total; }) + '" class="fc-total"/>'
      + (o.divFn ? '<path d="' + line(prim, function (p) { return p.div; }) + '" class="fc-div"/>' : '')
      + (sec ? '<path d="' + line(sec, function (p) { return p.total; }) + '" class="fc-low"/>' : '')
      + xt
      + endLabel(prim[last].total, "all-in " + fmt(prim[last].total, 1) + "%", "fc-lbl-total", o.divFn && Math.abs(y(prim[last].total) - y(prim[last].div)) < 11 ? -6 : 0)
      + (o.divFn ? endLabel(prim[last].div, "dividends " + fmt(prim[last].div, 1) + "%", "fc-lbl-div", Math.abs(y(prim[last].total) - y(prim[last].div)) < 11 ? 8 : 0) : '')
      + (sec ? endLabel(sec[last].total, "at " + o.secondary.exposure + "× " + fmt(sec[last].total, 1) + "%", "fc-lbl-low", 0) : '')
      + '</svg>';

    var legend = '<div class="ch-legend">'
      + '<span><i class="sw-fc-fees"></i>Fees (flat)</span>'
      + (L > 1 ? '<span><i class="sw-fc-fin"></i>Financing (moves with ' + (o.rateName || "rates") + ')</span>' : '')
      + '<span><i class="sw-fc-total"></i>All-in at ' + L + '×</span>'
      + (sec ? '<span><i class="sw-fc-low"></i>All-in at ' + o.secondary.exposure + '× (after a vol latch-down)</span>' : '')
      + (o.divFn ? '<span><i class="sw-fc-div"></i>Dividends received (yield × ' + L + ')</span>' : '')
      + '<span class="ch-note">% of capital per year, while invested</span>'
      + '</div>';

    return '<div class="fee-box">'
      + '<div class="detail-head"><h2 style="margin:0;">Fees at ' + L + '× — headline and history</h2></div>'
      + tiles + quoted
      + '<div class="chart-wrap">' + svg + '</div>' + legend
      + '<div class="toolsrow">Approximated from the product fields below and the monthly ' + (o.rateName || "reference rate")
      + ' history — the same inputs the backtest uses, so this chart and the matrix cannot disagree. Change a field below and it redraws.</div>'
      + '</div>';
  }

  return { render: render };
})();
