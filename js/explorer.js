// S&P Leverage explorer.
//
// Sweeps the *binary* version of the S&P strategy — in at a fixed leverage,
// out to cash, no vol gate — across a grid of SMA lengths (rows) and
// symmetric buffers (columns), so the live 200d/3% choice can be read in
// context. The gated 5x/3x version is a later addition.
//
// The binary strategy is not new logic: it's the engine's existing
// `fixedLeverage` mode with volGate null and leverage {base: L, gated: null},
// so StrategyEngine.walk is reused unchanged.
window.Explorer = (function () {
  var fmt = window.App.fmt;
  var ASSET = "SPX_MERGED"; // the only series reaching back far enough

  var GRIDS = {
    broad: { smas: [50, 100, 120, 150, 200, 250, 300], buffers: [0, 1, 2, 3, 5, 7.5, 10] },
    zoom:  { smas: [150, 175, 200, 225, 250, 275, 300], buffers: [0, 1, 2, 3, 4, 5, 6] }
  };
  var PERIODS = [
    { label: "All", from: null, to: null },
    { label: "1970+", from: "1970-01-01", to: null },
    { label: "1990+", from: "1990-01-01", to: null },
    { label: "2000+", from: "2000-01-01", to: null },
    { label: "2010+", from: "2010-01-01", to: null },
    { label: "1970–2000", from: "1970-01-01", to: "2000-01-01" },
    { label: "2000–2010", from: "2000-01-01", to: "2010-01-01" }
  ];
  var LEVERAGES = [1, 2, 3, 5];
  var LIVE = { sma: 200, buffer: 3 }; // the strategy actually being run

  var state = {
    periodIdx: 0, leverage: 5, grid: "broad", metric: "calmar", selected: null,
    perfMode: "total", annMode: "calendar"
  };
  var walkCache = {}; // "sma|buffer" -> { state01, sma, startIdx }

  function paramsFor(smaLen, bufferPct) {
    return {
      smaLen: smaLen, buffer: bufferPct / 100,
      volLen: null, volGate: null, annualization: 252,
      // Walk at 1x: for a binary strategy the *timing* of in/out doesn't
      // depend on leverage at all, so one walk serves every leverage setting
      // and the cache survives flipping between them.
      leverage: { base: 1, gated: null },
      sizing: { mode: "fixedLeverage" }
    };
  }

  function walkFor(prices, smaLen, bufferPct) {
    var key = smaLen + "|" + bufferPct;
    if (walkCache[key]) return walkCache[key];
    var w = window.StrategyEngine.walk(prices, paramsFor(smaLen, bufferPct));
    walkCache[key] = { state: w.state, sma: w.sma, startIdx: w.startIdx };
    return walkCache[key];
  }

  function periodBounds(prices, period) {
    var lo = period.from ? prices.findIndex(function (p) { return p.date >= period.from; }) : 0;
    if (lo < 0) lo = 0;
    var hi = prices.length - 1;
    if (period.to) {
      for (var i = prices.length - 1; i >= 0; i--) { if (prices[i].date < period.to) { hi = i; break; } }
    }
    return { lo: lo, hi: hi };
  }

  // Compounds the window fresh from 1.0 at its start, applying the leverage to
  // the cached 1x in/out timing.
  //
  // Capital restarts at the window start rather than inheriting its
  // full-history level. The in/out *state* still carries in, so there's no
  // artificial entry on day one — but a combo wiped out in 1987 would
  // otherwise make every later window unevaluable (0/0), which defeats the
  // point of a period selector. Each period answers "what would this have
  // done over these years", and RUINED means ruined *inside* this window.
  // For any combo that never blew up the two treatments are identical.
  function windowStats(prices, wk, period, leverage) {
    var b = periodBounds(prices, period);
    var lo = Math.max(b.lo, wk.startIdx), hi = b.hi;
    if (hi - lo < 2) return { insufficient: true };

    var eq = 1, peak = 1, maxDD = 0, ruinDate = null, trades = 0;
    for (var i = lo + 1; i <= hi; i++) {
      var prevIn = wk.state[i - 1] > 0;
      if (prevIn !== (wk.state[i] > 0)) trades++;
      var r = prices[i].close / prices[i - 1].close - 1;
      var factor = prevIn ? 1 + leverage * r : 1;
      if (factor <= 0) { if (!ruinDate) ruinDate = prices[i].date; eq = 0; }
      else if (eq > 0) { eq *= factor; }
      if (eq > peak) peak = eq;
      var dd = eq / peak - 1;
      if (dd < maxDD) maxDD = dd;
    }

    var years = (new Date(prices[hi].date) - new Date(prices[lo].date)) / (1000 * 60 * 60 * 24 * 365.25);
    if (years <= 0) return { insufficient: true };
    var cagr = eq > 0 ? (Math.pow(eq, 1 / years) - 1) * 100 : -100;

    return {
      cagr: cagr, maxDD: maxDD * 100,
      calmar: maxDD < 0 ? cagr / Math.abs(maxDD * 100) : null,
      ruined: !!ruinDate, ruinDate: ruinDate,
      years: years, trades: trades, tradesPerYear: trades / years,
      from: prices[lo].date, to: prices[hi].date
    };
  }

  // --- colour -------------------------------------------------------------
  // Diverging (polarity: did it make or lose money) — two hues with a neutral
  // midpoint at zero, never a rainbow. Blue/red rather than the site's usual
  // green/red because red-green is the worst possible pairing for the most
  // common colour blindness, and here the fill IS the encoding. Every step was
  // contrast-checked to keep the cell's printed numbers >=4.5:1 readable.
  var RAMP_NEG = ["neg4", "neg3", "neg2", "neg1"]; // most negative -> least
  var RAMP_POS = ["pos1", "pos2", "pos3", "pos4"]; // least positive -> most

  function rampClass(value, maxAbs) {
    if (value == null || !isFinite(value)) return "cell-na";
    if (maxAbs <= 0) return "cell-mid";
    var t = Math.min(1, Math.abs(value) / maxAbs);
    var step = Math.min(3, Math.floor(t * 4));
    if (Math.abs(value) < maxAbs * 0.02) return "cell-mid";
    return "cell-" + (value < 0 ? RAMP_NEG[3 - step] : RAMP_POS[step]);
  }

  function metricValue(s) {
    if (!s || s.insufficient || s.ruined) return null;
    return state.metric === "calmar" ? s.calmar : s.cagr;
  }

  // --- rendering ----------------------------------------------------------
  function btnRow(items, activeTest, dataAttr) {
    return items.map(function (it) {
      return '<button class="winbtn' + (activeTest(it) ? " active" : "") + '" ' + dataAttr(it) + '>' + it.label + '</button>';
    }).join("");
  }

  function controlsHTML() {
    return '<div class="exp-controls">'
      + '<div class="exp-ctl"><label>Period</label><div class="winbtns">'
      + btnRow(PERIODS.map(function (p, i) { return { label: p.label, i: i }; }),
               function (it) { return it.i === state.periodIdx; },
               function (it) { return 'data-period="' + it.i + '"'; })
      + '</div></div>'
      + '<div class="exp-ctl"><label>Leverage</label><div class="winbtns">'
      + btnRow(LEVERAGES.map(function (l) { return { label: l + "x", l: l }; }),
               function (it) { return it.l === state.leverage; },
               function (it) { return 'data-lev="' + it.l + '"'; })
      + '</div></div>'
      + '<div class="exp-ctl"><label>Grid</label><div class="winbtns">'
      + btnRow([{ label: "Broad", g: "broad" }, { label: "Zoomed", g: "zoom" }],
               function (it) { return it.g === state.grid; },
               function (it) { return 'data-grid="' + it.g + '"'; })
      + '</div></div>'
      + '<div class="exp-ctl"><label>Colour by</label><div class="winbtns">'
      + btnRow([{ label: "Calmar", m: "calmar" }, { label: "CAGR", m: "cagr" }],
               function (it) { return it.m === state.metric; },
               function (it) { return 'data-metric="' + it.m + '"'; })
      + '</div></div>'
      + '</div>';
  }

  function legendHTML(maxAbs) {
    var swatches = RAMP_NEG.map(function (c) { return '<i class="cell-' + c + '"></i>'; }).join("")
      + '<i class="cell-mid"></i>'
      + RAMP_POS.map(function (c) { return '<i class="cell-' + c + '"></i>'; }).join("");
    var unit = state.metric === "calmar" ? "" : "%";
    return '<div class="exp-legend">'
      + '<span class="lg-end">' + (maxAbs ? "−" + fmt(maxAbs, 1) + unit : "−") + '</span>'
      + '<span class="lg-ramp">' + swatches + '</span>'
      + '<span class="lg-end">' + (maxAbs ? "+" + fmt(maxAbs, 1) + unit : "+") + '</span>'
      + '<span class="lg-note">'
      + (state.metric === "calmar"
        ? "Calmar = CAGR ÷ worst drawdown — higher means the return was bought with less pain."
        : "CAGR = compound annual growth rate over the selected period.")
      + ' Ruined combos are excluded from the scale.</span>'
      + '</div>';
  }

  function cellTitle(sma, buf, s) {
    if (!s || s.insufficient) return sma + "d / " + buf + "% — not enough history in this period";
    if (s.ruined) {
      return sma + "d / " + buf + "% — WIPED OUT" + (s.ruinDate ? " on " + s.ruinDate : "")
        + (s.deadBefore ? " (before this period began)" : "")
        + "\nAt " + state.leverage + "x a single day worse than −" + fmt(100 / state.leverage, 1) + "% destroys the position.";
    }
    return sma + "d SMA / " + buf + "% buffer"
      + "\nCAGR " + fmt(s.cagr, 1) + "%   max drawdown " + fmt(s.maxDD, 1) + "%"
      + "\nCalmar " + (s.calmar == null ? "—" : fmt(s.calmar, 2))
      + "\n" + fmt(s.tradesPerYear, 1) + " round trips/yr over " + fmt(s.years, 1) + " years";
  }

  function render(container, data) {
    var prices = data[window.App.assetKey(ASSET)];
    if (!prices || !prices.length) {
      container.innerHTML = '<div class="panel"><div class="fatal">No ' + ASSET + ' data loaded.</div></div>';
      return;
    }
    var grid = GRIDS[state.grid];
    var period = PERIODS[state.periodIdx];

    // Compute every cell, then derive the colour domain from survivors only —
    // a ruined cell must not stretch the ramp.
    var cells = grid.smas.map(function (sma) {
      return grid.buffers.map(function (buf) {
        return windowStats(prices, walkFor(prices, sma, buf), period, state.leverage);
      });
    });
    var maxAbs = 0;
    cells.forEach(function (row) {
      row.forEach(function (s) {
        var v = metricValue(s);
        if (v != null && isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
      });
    });

    var head = '<tr><th class="corner">SMA \\ buffer</th>'
      + grid.buffers.map(function (b) { return '<th>' + b + '%</th>'; }).join("") + '</tr>';

    var body = grid.smas.map(function (sma, r) {
      return '<tr><th>' + sma + 'd</th>' + grid.buffers.map(function (buf, c) {
        var s = cells[r][c];
        var isLive = sma === LIVE.sma && buf === LIVE.buffer;
        var isSel = state.selected && state.selected.sma === sma && state.selected.buffer === buf;
        var cls, inner;
        if (s.insufficient) { cls = "cell-na"; inner = '<span class="c-main">—</span>'; }
        else if (s.ruined) {
          cls = "cell-ruined";
          inner = '<span class="c-main">RUINED</span><span class="c-sub">'
            + (s.ruinDate ? s.ruinDate.slice(0, 4) : "pre-period") + '</span>';
        } else {
          cls = rampClass(metricValue(s), maxAbs);
          inner = '<span class="c-main">' + (s.cagr >= 0 ? "+" : "") + fmt(s.cagr, 1) + '%</span>'
            + '<span class="c-sub">' + fmt(s.maxDD, 1) + '%</span>';
        }
        return '<td class="mcell ' + cls + (isLive ? " is-live" : "") + (isSel ? " is-sel" : "") + '"'
          + ' tabindex="0" role="button"'
          + ' data-sma="' + sma + '" data-buf="' + buf + '"'
          + ' title="' + cellTitle(sma, buf, s).replace(/"/g, "&quot;") + '">' + inner + '</td>';
      }).join("") + '</tr>';
    }).join("");

    var ruinedCount = 0, total = 0;
    cells.forEach(function (row) { row.forEach(function (s) { total++; if (s.ruined) ruinedCount++; }); });

    var html = '<div class="panel">'
      + '<h2>S&amp;P leverage explorer &mdash; binary in/out at ' + state.leverage + 'x</h2>'
      + controlsHTML()
      + legendHTML(maxAbs)
      + '<div class="matrixwrap"><table class="matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
      + '<div class="toolsrow">'
      + 'Each cell: <strong>CAGR</strong> on top, <strong>max drawdown</strong> below. '
      + 'Ringed cell is the live 200d/3% setting. '
      + (ruinedCount
        ? '<strong>' + ruinedCount + ' of ' + total + ' combos were wiped out at ' + state.leverage + 'x</strong> — at this leverage any single day worse than −'
          + fmt(100 / state.leverage, 1) + '% takes the position to zero. '
        : 'No combo was wiped out at ' + state.leverage + 'x. ')
      + 'Backtested on ' + ASSET + ', a derived series (real SPX spliced to regression-converted SPY) — not raw data. '
      + 'Each period is compounded fresh from its own start, so RUINED means wiped out <em>inside</em> the selected window; '
      + 'the in/out signal still carries in from before it, so there is no artificial trade on day one.'
      + '</div></div>';

    if (state.selected) {
      var selWalk = walkFor(prices, state.selected.sma, state.selected.buffer);
      html += window.PriceChart.render(prices, state.selected, state.leverage, period, selWalk);
      html += window.PerfChart.render(prices, state.selected, state.leverage, period, selWalk,
        state.perfMode, state.annMode);
    }

    container.innerHTML = html;
    wire(container, data);
  }

  function wire(container, data) {
    function rerender() { render(container, data); }
    function bind(sel, fn) {
      container.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function () { fn(el); rerender(); });
      });
    }
    bind("[data-period]", function (el) { state.periodIdx = Number(el.getAttribute("data-period")); });
    bind("[data-lev]", function (el) { state.leverage = Number(el.getAttribute("data-lev")); });
    bind("[data-grid]", function (el) { state.grid = el.getAttribute("data-grid"); });
    bind("[data-metric]", function (el) { state.metric = el.getAttribute("data-metric"); });
    bind("[data-perf]", function (el) { state.perfMode = el.getAttribute("data-perf"); });
    bind("[data-ann]", function (el) { state.annMode = el.getAttribute("data-ann"); });

    container.querySelectorAll(".mcell").forEach(function (cell) {
      function toggle() {
        var sma = Number(cell.getAttribute("data-sma")), buf = Number(cell.getAttribute("data-buf"));
        state.selected = (state.selected && state.selected.sma === sma && state.selected.buffer === buf)
          ? null : { sma: sma, buffer: buf };
        rerender();
      }
      cell.addEventListener("click", toggle);
      cell.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  return { render: render };
})();
