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

  var W = 760, PAD_L = 52, PAD_R = 12, PAD_T = 14;
  // GAP has to clear the main plot's own x-labels before the underwater
  // panel's caption starts, or the two collide.
  var MAIN_H = 200, GAP = 44, UW_H = 92, PAD_B = 30;
  var H = PAD_T + MAIN_H + GAP + UW_H + PAD_B;
  var PLOT_W = W - PAD_L - PAD_R;
  var UW_TOP = PAD_T + MAIN_H + GAP;
  var MAX_POINTS = 1100;

  // Compound the selected window, recording equity, the running peak and the
  // drawdown at each step. Mirrors windowStats() in js/explorer.js — the two
  // are deliberately separate so their max-drawdown figures cross-check.
  function buildSeries(prices, wk, leverage, lo, hi) {
    var eq = 1, peak = 1;
    var out = [{ date: prices[lo].date, eq: 1, dd: 0, hold: 1 }];
    var ruinIdx = -1;
    var base = prices[lo].close;
    for (var i = lo + 1; i <= hi; i++) {
      var prevIn = wk.state[i - 1] > 0;
      var r = prices[i].close / prices[i - 1].close - 1;
      var factor = prevIn ? 1 + leverage * r : 1;
      if (factor <= 0) { if (ruinIdx < 0) ruinIdx = out.length; eq = 0; }
      else if (eq > 0) eq *= factor;
      if (eq > peak) peak = eq;
      out.push({
        date: prices[i].date, eq: eq,
        dd: peak > 0 ? eq / peak - 1 : -1,
        hold: prices[i].close / base
      });
    }
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
  function render(prices, selected, leverage, period, wk, mode, annMode) {
    var lo = period.from ? prices.findIndex(function (p) { return p.date >= period.from; }) : 0;
    if (lo < 0) lo = 0;
    lo = Math.max(lo, wk.startIdx);
    var hi = prices.length - 1;
    if (period.to) {
      for (var i = prices.length - 1; i >= 0; i--) { if (prices[i].date < period.to) { hi = i; break; } }
    }
    if (hi - lo < 3) return '<div class="panel"><div class="loading">Not enough history in this period.</div></div>';

    var built = buildSeries(prices, wk, leverage, lo, hi);
    var pts = built.pts;
    var ruined = built.ruinIdx >= 0;
    var ruinDate = ruined ? pts[built.ruinIdx].date : null;

    var t0 = new Date(pts[0].date).getTime();
    var t1 = new Date(pts[pts.length - 1].date).getTime();
    var spanT = Math.max(1, t1 - t0);
    function x(d) { return PAD_L + ((new Date(d).getTime() - t0) / spanT) * PLOT_W; }

    var stride = Math.max(1, Math.ceil(pts.length / MAX_POINTS));
    var svg = "", legend = "", note = "";

    // ---- top plot ----
    if (mode === "total") {
      // Log axis: zero equity has no position on it, so the curve is clamped
      // to the axis floor after a wipeout and the event is marked instead.
      var lo2 = Infinity, hi2 = -Infinity;
      pts.forEach(function (p) {
        if (p.eq > 0) { lo2 = Math.min(lo2, p.eq); hi2 = Math.max(hi2, p.eq); }
        lo2 = Math.min(lo2, p.hold); hi2 = Math.max(hi2, p.hold);
      });
      if (!isFinite(lo2) || lo2 <= 0) lo2 = 1e-3;
      var lLo = Math.log10(lo2), lHi = Math.log10(hi2);
      if (lHi - lLo < 0.05) lHi = lLo + 0.05;
      function yLog(v) {
        var lv = v > 0 ? Math.log10(v) : lLo;      // clamp 0 to the floor
        return PAD_T + (1 - (Math.min(Math.max(lv, lLo), lHi) - lLo) / (lHi - lLo)) * MAIN_H;
      }
      function nice(v) { var p = Math.floor(Math.log10(v)), b = Math.pow(10, p), m = v / b; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * b; }
      var seen = {};
      for (var g = 0; g <= 4; g++) {
        var gv = nice(Math.pow(10, lLo + (lHi - lLo) * (g / 4)));
        if (seen[gv] || gv <= 0) continue; seen[gv] = 1;
        var gy = yLog(gv);
        if (gy < PAD_T - 1 || gy > PAD_T + MAIN_H + 1) continue;
        svg += '<line x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '" class="ch-grid"/>'
          + '<text x="' + (PAD_L - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" class="ch-axis" text-anchor="end">' + fmt(gv, gv < 1 ? 2 : 0) + '×</text>';
      }
      function linePath(key) {
        var d = "", first = true;
        for (var i = 0; i < pts.length; i += stride) {
          d += (first ? "M" : "L") + x(pts[i].date).toFixed(1) + " " + yLog(pts[i][key]).toFixed(1);
          first = false;
        }
        return d;
      }
      svg += '<path d="' + linePath("hold") + '" class="ch-hold"/>'
        + '<path d="' + linePath("eq") + '" class="ch-strat"/>';
      if (ruined) {
        var rx = x(ruinDate);
        svg += '<line x1="' + rx.toFixed(1) + '" y1="' + PAD_T + '" x2="' + rx.toFixed(1) + '" y2="' + (PAD_T + MAIN_H) + '" class="pf-ruinline"/>'
          + '<text x="' + Math.min(rx + 5, W - PAD_R - 90).toFixed(1) + '" y="' + (PAD_T + 12) + '" class="pf-ruintext">wiped out ' + ruinDate + '</text>';
      }
      legend = '<span><i class="sw-strat"></i>Strategy at ' + leverage + '× <b>' + (pts[pts.length - 1].eq > 0 ? fmt(pts[pts.length - 1].eq, 2) + '×' : '0 — wiped out') + '</b></span>'
        + '<span><i class="sw-hold"></i>Buy &amp; hold (1×) <b>' + fmt(pts[pts.length - 1].hold, 2) + '×</b></span>'
        + '<span class="ch-note">log scale, rebased to 1× at ' + pts[0].date + '</span>';
      note = 'Total growth of £1. Buy &amp; hold is shown unleveraged for reference, so the gap is what the leverage and the timing did together.';
    } else {
      // Annualised: linear % axis with an emphasised zero line.
      var bars = annMode === "calendar" ? calendarYears(pts) : null;
      var line = annMode === "rolling10" ? rollingAnnualised(pts, 10)
               : annMode === "since" ? sinceStart(pts) : null;
      var vals = bars ? bars.map(function (b) { return b.value; }) : line.map(function (p) { return p.value; });
      if (!vals.length) return '<div class="panel"><div class="loading">Not enough history for this view.</div></div>';
      var vMin = Math.min(0, Math.min.apply(null, vals));
      var vMax = Math.max(0, Math.max.apply(null, vals));
      // Snap the axis to a round step so ticks read 0/100/200% rather than
      // 18/176/333%, and so the zero line always lands on a tick.
      var rawStep = (vMax - vMin) / 4 || 1;
      var mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
      var norm = rawStep / mag;
      var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
      vMin = Math.floor(vMin / step) * step;
      vMax = Math.ceil(vMax / step) * step;
      function yLin(v) { return PAD_T + (1 - (v - vMin) / (vMax - vMin)) * MAIN_H; }

      for (var tv = vMin; tv <= vMax + 1e-9; tv += step) {
        var ty = yLin(tv);
        svg += '<line x1="' + PAD_L + '" y1="' + ty.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + ty.toFixed(1) + '" class="ch-grid"/>'
          + '<text x="' + (PAD_L - 6) + '" y="' + (ty + 3.5).toFixed(1) + '" class="ch-axis" text-anchor="end">' + fmt(tv, 0) + '%</text>';
      }
      var zy = yLin(0);
      svg += '<line x1="' + PAD_L + '" y1="' + zy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + zy.toFixed(1) + '" class="pf-zero"/>';

      if (bars) {
        var bw = Math.max(1.5, (PLOT_W / bars.length) - 2);
        bars.forEach(function (b, i2) {
          var bx = PAD_L + (i2 + 0.5) * (PLOT_W / bars.length) - bw / 2;
          var by = yLin(Math.max(0, b.value)), bh = Math.abs(yLin(b.value) - zy);
          svg += '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, bh).toFixed(1)
            + '" class="pf-bar ' + (b.value >= 0 ? "pos" : "neg") + (b.partial ? " partial" : "") + '">'
            + '<title>' + b.label + (b.partial ? " (partial year)" : "") + ": " + (b.value >= 0 ? "+" : "") + fmt(b.value, 1) + '%</title></rect>';
        });
        // Label a readable subset of years.
        var every = Math.ceil(bars.length / 8);
        bars.forEach(function (b, i3) {
          if (i3 % every) return;
          svg += '<text x="' + (PAD_L + (i3 + 0.5) * (PLOT_W / bars.length)).toFixed(1) + '" y="' + (PAD_T + MAIN_H + 14) + '" class="ch-axis" text-anchor="middle">' + b.label + '</text>';
        });
        var nPartial = bars.filter(function (b) { return b.partial; }).length;
        legend = '<span><i class="sw-pos"></i>Positive year</span><span><i class="sw-neg"></i>Negative year</span>'
          + (nPartial ? '<span class="ch-note">hatched = partial year at the window edge</span>' : '');
        note = 'Return for each calendar year, chained from the previous year&#8217;s close.'
          + (nPartial ? ' The first and last bars cover part of a year only &mdash; shown as the actual part-year return, not annualised.' : '');
      } else {
        var st2 = Math.max(1, Math.ceil(line.length / MAX_POINTS));
        var d2 = "", f2 = true;
        for (var i4 = 0; i4 < line.length; i4 += st2) {
          d2 += (f2 ? "M" : "L") + x(line[i4].date).toFixed(1) + " " + yLin(line[i4].value).toFixed(1);
          f2 = false;
        }
        svg += '<path d="' + d2 + '" class="ch-strat"/>';
        var last2 = line[line.length - 1];
        legend = '<span><i class="sw-strat"></i>'
          + (annMode === "rolling10" ? "Trailing 10-year annualised" : "Annualised since " + pts[0].date)
          + ' <b>' + (last2.value >= 0 ? "+" : "") + fmt(last2.value, 1) + '%</b> latest</span>';
        note = annMode === "rolling10"
          ? 'Annualised return over the preceding 10 years, at every date. The spread between its high and low is how much your <em>start date</em> mattered.'
          : 'Annualised return from the window start to each date &mdash; noisy early, converging on the headline CAGR.';
      }
    }

    // ---- x labels (shared) ----
    [0, Math.floor(pts.length / 2), pts.length - 1].forEach(function (i5, k) {
      svg += '<text x="' + x(pts[i5].date).toFixed(1) + '" y="' + (H - 8) + '" class="ch-axis" text-anchor="'
        + (k === 0 ? "start" : k === 2 ? "end" : "middle") + '">' + pts[i5].date.slice(0, 7) + '</text>';
    });

    // ---- underwater panel ----
    var worst = pts[0], worstI = 0;
    pts.forEach(function (p, i6) { if (p.dd < worst.dd) { worst = p; worstI = i6; } });
    function yUW(dd) { return UW_TOP + (-dd) * UW_H; }   // 0 at top, -100% at bottom

    svg += '<line x1="' + PAD_L + '" y1="' + UW_TOP + '" x2="' + (W - PAD_R) + '" y2="' + UW_TOP + '" class="pf-zero"/>'
      + '<text x="' + (PAD_L - 6) + '" y="' + (UW_TOP + 3.5) + '" class="ch-axis" text-anchor="end">0%</text>'
      + '<text x="' + (PAD_L - 6) + '" y="' + (UW_TOP + UW_H) + '" class="ch-axis" text-anchor="end">−100%</text>'
      + '<text x="' + PAD_L + '" y="' + (UW_TOP - 6) + '" class="ch-axis">Underwater &mdash; how far below the previous peak</text>';

    var uw = "M" + PAD_L.toFixed(1) + " " + UW_TOP.toFixed(1);
    for (var i7 = 0; i7 < pts.length; i7 += stride) {
      uw += "L" + x(pts[i7].date).toFixed(1) + " " + yUW(pts[i7].dd).toFixed(1);
    }
    uw += "L" + x(pts[pts.length - 1].date).toFixed(1) + " " + UW_TOP.toFixed(1) + "Z";
    svg += '<path d="' + uw + '" class="pf-uw"/>';

    var wx = x(worst.date), wy = yUW(worst.dd);
    svg += '<circle cx="' + wx.toFixed(1) + '" cy="' + wy.toFixed(1) + '" r="3" class="pf-worst"/>'
      + '<text x="' + Math.min(Math.max(wx + 6, PAD_L), W - PAD_R - 120).toFixed(1) + '" y="' + Math.max(wy - 5, UW_TOP + 10).toFixed(1)
      + '" class="pf-worsttext">worst ' + fmt(worst.dd * 100, 1) + '% · ' + worst.date + '</text>';

    // How long it stayed under water after the worst point.
    var recovered = null;
    for (var i8 = worstI; i8 < pts.length; i8++) { if (pts[i8].dd >= -0.0001) { recovered = pts[i8].date; break; } }
    var underNote = recovered
      ? 'Back to its previous peak on ' + recovered + ' — ' + fmt(yearsBetween(worst.date, recovered), 1) + ' years after the low.'
      : 'Never regained its previous peak within this period.';

    return '<div class="panel">'
      + '<div class="detail-head"><h2>Performance &mdash; ' + selected.sma + 'd / ' + selected.buffer + '% at ' + leverage + '×</h2>'
      + '<div class="winbtns">'
      + '<button class="winbtn' + (mode === "total" ? " active" : "") + '" data-perf="total">Total return</button>'
      + '<button class="winbtn' + (mode === "ann" ? " active" : "") + '" data-perf="ann">Annualised</button>'
      + '</div></div>'
      + (mode === "ann"
        ? '<div class="winbtns sub"><button class="winbtn' + (annMode === "calendar" ? " active" : "") + '" data-ann="calendar">Calendar years</button>'
          + '<button class="winbtn' + (annMode === "rolling10" ? " active" : "") + '" data-ann="rolling10">Rolling 10y</button>'
          + '<button class="winbtn' + (annMode === "since" ? " active" : "") + '" data-ann="since">Since start</button></div>'
        : "")
      + '<div class="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" preserveAspectRatio="xMidYMid meet" role="img"'
      + ' aria-label="Strategy performance with an underwater drawdown panel">' + svg + '</svg></div>'
      + '<div class="ch-legend">' + legend + '</div>'
      + '<div class="toolsrow">' + note + ' <strong>' + underNote + '</strong></div>'
      + '</div>';
  }

  return { render: render };
})();
