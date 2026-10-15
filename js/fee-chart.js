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
  var Plot = window.Plot;

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

  // o: {
  //   primary:   { exposure, product }        product = { mgmtFeePct, dailySwapRatePct, fundingSpreadPct } (spread incl. basis)
  //   secondary: same shape or null           the reduced leverage of a vol-gated strategy
  //   rateFn, rateName, rateNow, rateNowMonth, rateEarliest   reference-rate lookup (pct) and its provenance
  //   divFn: (dateStr) -> yield pct or null
  //   from, to: date strings bounding the chart
  //   productName, quotedCharge: display strings / number (platform "ongoing charge" = fee + swap x 360)
  //   cap: the strategy's cost cap, % a year (0 = off) — drawn as a line: in
  //        months where the all-in line is above it, the cap holds less leverage
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

    // ---- chart (Plotly, js/plot.js) ----
    // Monthly points, a few hundred at most, so nothing is decimated. Traces
    // are added in a fixed order and the legend's data-trace indexes follow it.
    var n = prim.length;
    var last = n - 1;
    var xs = months.map(function (m) { return m + "-15"; });
    var idx = { fees: 0, fin: 1, total: 2 }, next = 3;
    if (o.divFn) idx.div = next++;
    if (sec) idx.low = next++;

    // Months before the reference series begins hold its first value — say so,
    // don't let a flat stretch look like data.
    var heldTo = null;
    if (o.rateEarliest && months[0] < o.rateEarliest && L > 1) {
      var k2 = months.findIndex(function (m) { return m >= o.rateEarliest; });
      if (k2 < 0) k2 = n - 1;
      if (k2 > 0) heldTo = xs[k2];
    }
    // End-of-line labels; nudged apart when the total and dividend lines end close together.
    var close = o.divFn && Math.abs(prim[last].total - prim[last].div) < (Math.max(prim[last].total, prim[last].div) || 1) * 0.08;

    var slot = Plot.slot({
      height: 270, group: "explorer", key: "explorer-fee", legendScope: ".fee-box",
      label: "Approximate all-in annual cost of " + L + " times leverage by month, from " + months[0] + " to " + months[last]
        + ": now " + fmt(nowDrag.totalPct, 1) + " percent a year, average " + fmt(avg, 1) + ", peak " + fmt(peak.total, 1) + " in " + peak.m,
      build: function (t) {
        var data = [
          { x: xs, y: prim.map(function (p) { return p.fees; }), type: "scatter", mode: "lines", name: "Fees",
            line: { width: 0 }, fill: "tozeroy", fillcolor: t.alpha(t.inkFaint, 0.34), hovertemplate: "Fees %{y:.2f}%<extra></extra>" },
          { x: xs, y: prim.map(function (p) { return p.total; }), type: "scatter", mode: "lines", name: "Financing",
            line: { width: 0 }, fill: "tonexty", fillcolor: t.alpha(t.warn, 0.26),
            customdata: prim.map(function (p) { return p.fin; }), hovertemplate: "Financing %{customdata:.2f}%<extra></extra>" },
          { x: xs, y: prim.map(function (p) { return p.total; }), type: "scatter", mode: "lines", name: "All-in at " + L + "×",
            line: { color: t.warn, width: 1.6 }, hovertemplate: "All-in at " + L + "× %{y:.2f}%<extra></extra>" }
        ];
        if (o.divFn) data.push({ x: xs, y: prim.map(function (p) { return p.div; }), type: "scatter", mode: "lines", name: "Dividends",
          line: { color: t.long, width: 1.5, dash: "6px,3px" }, hovertemplate: "Dividends received %{y:.2f}%<extra></extra>" });
        if (sec) data.push({ x: xs, y: sec.map(function (p) { return p.total; }), type: "scatter", mode: "lines", name: "All-in at " + o.secondary.exposure + "×",
          line: { color: t.flat, width: 1.5, dash: "2px,3px" }, hovertemplate: "All-in at " + o.secondary.exposure + "× %{y:.2f}%<extra></extra>" });

        function endNote(v, text, color, shift) {
          return { text: text, x: 1, xref: "paper", y: v, yref: "y", xanchor: "left", xshift: 5, yshift: shift || 0, showarrow: false, font: { size: 10, color: color } };
        }
        var notes = [endNote(prim[last].total, "all-in " + fmt(prim[last].total, 1) + "%", t.warn, close ? 6 : 0)];
        if (o.divFn) notes.push(endNote(prim[last].div, "dividends " + fmt(prim[last].div, 1) + "%", t.long, close ? -8 : 0));
        if (sec) notes.push(endNote(sec[last].total, "at " + o.secondary.exposure + "× " + fmt(sec[last].total, 1) + "%", t.flat, 0));
        var shapes = [];
        if (o.cap > 0) {
          shapes.push({ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: o.cap, y1: o.cap, line: { color: t.ink, width: 1, dash: "dot" } });
          notes.push({ text: "cost cap " + o.cap + "%", x: 0, xref: "paper", y: o.cap, yref: "y", xanchor: "left", yanchor: "bottom", xshift: 4, showarrow: false, font: { size: 10, color: t.ink } });
        }
        if (heldTo) {
          shapes.push({ type: "rect", xref: "x", yref: "paper", x0: xs[0], x1: heldTo, y0: 0, y1: 1, line: { width: 0 }, fillcolor: t.alpha(t.inkFaint, 0.12), layer: "below" });
          notes.push({ text: "rate held at " + o.rateEarliest.slice(0, 4) + " level", x: xs[0], xref: "x", y: 1, yref: "paper", xanchor: "left", yanchor: "top", xshift: 4, showarrow: false, font: { size: 10, color: t.inkFaint } });
        }
        return {
          data: data,
          layout: {
            margin: { l: 46, r: 96, t: 8, b: 28 },
            xaxis: { hoverformat: "%b %Y" },
            yaxis: Object.assign(Plot.axisStyle(t), { ticksuffix: "%", rangemode: "tozero" }),
            annotations: notes, shapes: shapes
          }
        };
      }
    });

    var legend = '<div class="ch-legend">'
      + '<span data-trace="' + idx.fees + '"><i class="sw-fc-fees"></i>Fees (flat)</span>'
      + (L > 1 ? '<span data-trace="' + idx.fin + '"><i class="sw-fc-fin"></i>Financing (moves with ' + (o.rateName || "rates") + ')</span>' : '')
      + '<span data-trace="' + idx.total + '"><i class="sw-fc-total"></i>All-in at ' + L + '×</span>'
      + (sec ? '<span data-trace="' + idx.low + '"><i class="sw-fc-low"></i>All-in at ' + o.secondary.exposure + '× (after a vol latch-down)</span>' : '')
      + (o.divFn ? '<span data-trace="' + idx.div + '"><i class="sw-fc-div"></i>Dividends received (yield × ' + L + ')</span>' : '')
      + (o.cap > 0 ? '<span><i class="sw-fc-cap"></i>Cost cap &le;' + o.cap + '%/yr &mdash; above it, the strategy holds less leverage</span>' : '')
      + '<span class="ch-note">% of capital per year, while invested</span>'
      + '</div>';

    return '<div class="fee-box">'
      + '<div class="detail-head"><h2 style="margin:0;">Fees at ' + L + '× — headline and history</h2></div>'
      + tiles + quoted
      + slot + legend
      + '<div class="toolsrow">Approximated from the product fields below and the monthly ' + (o.rateName || "reference rate")
      + ' history — the same inputs the backtest uses, so this chart and the matrix cannot disagree. Change a field below and it redraws.</div>'
      + '</div>';
  }

  return { render: render };
})();
