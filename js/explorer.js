// Strategy Explorer (formerly the S&P Leverage explorer) — a design-space
// explorer across five assets.
//
// ONE current strategy lives in `state.params` (SMA, buffer, start leverage,
// drop-to leverage, vol window, vol gate, latch) and is edited in the parameter
// bar at the top. Up to three matrices sit below it; each has its own X and Y
// axis chosen from those same parameters, and every OTHER parameter is read
// from the bar. Clicking a cell writes its two values into the bar, so the
// other matrices, the summary and the charts all move to that strategy — that
// is how a selection in one matrix updates the others.
//
// Two sizing modes, both just parameters of the engine's existing
// `fixedLeverage` walk (StrategyEngine.walk), not new logic:
//   Fixed leverage — in at L, out to cash (volGate null).
//   Vol-gated      — enter at the high leverage only while realised vol is
//                    below a gate; when vol reaches the gate, drop to a lower
//                    leverage. Latched (default; the live S&P strategy) is a
//                    one-way ratchet that stays down until the next exit;
//                    unlatched follows vol both ways.
// Equity compounding (with costs) goes through StrategyEngine.compoundEquity —
// the same shared core js/perf-chart.js's underwater panel and the Developed
// tab's equity chart build on — so there is exactly one place that knows how
// leverage, ruin, and costs combine.
window.Explorer = (function () {
  var fmt = window.App.fmt;

  // What a strategy IS (parameters, validity, walking, scoring) lives in
  // js/strategy-config.js so the Evaluator tab scores identically. This tab owns
  // only its own UI state.
  var SC = window.StrategyConfig;
  var ASSETS = SC.ASSETS, PARAMS = SC.PARAMS, PARAM_ORDER = SC.PARAM_ORDER;
  var ALL_LEVERAGES = SC.ALL_LEVERAGES, OUT_LEVERAGES = SC.OUT_LEVERAGES, VOL_WINDOWS = SC.VOL_WINDOWS;

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
  var ALL_LEVERAGES = [1, 2, 3, 5];
  var SLIPPAGE_TIERS = ["low", "medium", "high"];

  // The single current strategy. Defaults to the live S&P strategy.
  var state = {
    asset: "SP500", periodIdx: 0, grid: "broad", metric: "calmar",
    sizing: "gated",
    params: { sma: 200, buffer: 3, high: 5, low: 3, out: 0, volwin: 20, gate: 22, latch: true },
    matrices: [{ x: "buffer", y: "sma" }, { x: "low", y: "high" }],
    perfMode: "total", annMode: "calendar"
  };
  var curCosts = null;   // the cost config for the asset being rendered (set by renderMain)
  var walkCache = {}; // stamp|sma|buffer|sizing -> { state, sma, startIdx, ... }
  var volCache = {};  // stamp|volLen -> realised-vol series, shared by every cell's walk
  var statsCache = {}; // stamp|period|costs|strategy -> window stats, so re-rendering after a click only recomputes what changed

  function assetConfig(key) { return SC.assetConfig(key); }

  // This tab's current strategy as a StrategyConfig descriptor.
  function curCfg(params) { return { asset: state.asset, sizing: state.sizing, params: params || state.params }; }

  var MAX_MATRICES = 3;
  var NEW_MATRIX_DEFAULTS = [{ x: "low", y: "high" }, { x: "volwin", y: "gate" }, { x: "buffer", y: "sma" }];

  function parseVal(key, str) { return key === "latch" ? str === "true" : Number(str); }
  function isGated() { return SC.isGated(curCfg()); }
  function minAbove(p) { return SC.minAbove(curCfg(p)); }
  function resolve(p, costs) { return SC.resolve(curCfg(p), costs); }
  function describeStrategy(p, gs) { return SC.describe(curCfg(p), gs); }
  function walkFor(prices, assetKey, smaLen, bufferPct, gs, tier) { return SC.walkFor(prices, assetKey, smaLen, bufferPct, gs, tier); }
  function periodBounds(prices, period) { return SC.periodBounds(prices, period); }
  function costConfigFor(costAssumptions, assetKey) { return SC.costConfigFor(costAssumptions, assetKey); }
  function refSeriesFn(refRates, name) { return SC.refSeriesFn(refRates, name); }
  function engineCostsFrom(cfg, refRates) { return SC.engineCostsFrom(cfg, refRates); }
  function costVariant(ec, on) { return SC.costVariant(ec, on); }
  function windowStats(prices, wk, period, leverage, costs) { return SC.windowStats(prices, wk, period, leverage, costs); }
  function cellStats(env, p) { return SC.evaluate(env, curCfg(p)); }

  // Clamps the current strategy to what the asset and sizing mode allow.
  function normalizeParams(asset, costs) {
    var c = curCfg();
    SC.normalize(c, costs);
    state.sizing = c.sizing;
  }

  // The values an axis shows. The current value is spliced in for free-form
  // parameters so "where am I" is always visible in a matrix.
  function axisValues(key, asset, costs) {
    var list;
    if (key === "sma") list = GRIDS[state.grid].smas;
    else if (key === "buffer") list = GRIDS[state.grid].buffers;
    else if (key === "high") list = ALL_LEVERAGES.filter(function (l) { return l <= costs.maxLeverage && (!isGated(asset) || l > 1); });
    else if (key === "low") list = ALL_LEVERAGES.filter(function (l) { return l < costs.maxLeverage; });
    else if (key === "out") list = OUT_LEVERAGES.filter(function (l) { return l <= costs.maxLeverage; });
    else if (key === "volwin") list = VOL_WINDOWS;
    else if (key === "gate") {
      list = asset.gate ? asset.gate.options : [];
      if (state.grid === "zoom" && list.length) {
        var fine = [];
        for (var v = list[0]; v <= list[list.length - 1]; v += 2) fine.push(v);
        list = fine;
      }
    } else if (key === "latch") list = [true, false];
    else list = [];
    var cur = state.params[key];
    if ((key === "sma" || key === "buffer" || key === "volwin" || key === "gate") && list.length && list.indexOf(cur) < 0) {
      list = list.concat([cur]).sort(function (a, b) { return a - b; });
    }
    return list;
  }

  // The gating settings actually in force for the CURRENT strategy.
  function gateSettings() {
    var r = curCosts ? resolve(state.params, curCosts) : { gs: { enabled: false } };
    return r.gs || { enabled: false };
  }

  // --- colour -------------------------------------------------------------
  var RAMP_NEG = ["neg4", "neg3", "neg2", "neg1"];
  var RAMP_POS = ["pos1", "pos2", "pos3", "pos4"];

  function rampClass(value, maxAbs) {
    if (value == null || !isFinite(value)) return "cell-na";
    if (maxAbs <= 0) return "cell-mid";
    var t = Math.min(1, Math.abs(value) / maxAbs);
    var step = Math.min(3, Math.floor(t * 4));
    if (Math.abs(value) < maxAbs * 0.02) return "cell-mid";
    return "cell-" + (value < 0 ? RAMP_NEG[3 - step] : RAMP_POS[step]);
  }

  // --- rendering ----------------------------------------------------------
  function btnRow(items, activeTest, dataAttr, disabledTest) {
    return items.map(function (it) {
      var dis = disabledTest && disabledTest(it);
      return '<button class="winbtn' + (activeTest(it) ? " active" : "") + '"'
        + (dis ? ' disabled title="' + dis.replace(/"/g, "&quot;") + '"' : "")
        + " " + dataAttr(it) + '>' + it.label + '</button>';
    }).join("");
  }

  // sourced = printed in a named document; fitted = estimated by matching real
  // traded prices; assumed = my assumption; edited = typed in by you.
  function confBadge(conf) {
    var cls = conf === "sourced" ? "conf-sourced" : (conf === "edited" ? "conf-edited" : "conf-estimated");
    return '<span class="conf-badge ' + cls + '">' + (conf === "edited" ? "your edit" : conf) + '</span>';
  }

  function gateSummary(gs) {
    var v = gs.volLen + "-day volatility", g = gs.gatePct + "%";
    return "Enters at " + gs.high + "× only while " + v + " is below " + g + " (otherwise it waits, out of the market, until vol calms). "
      + (gs.latch
        ? "If vol reaches " + g + " or more while invested it drops to " + gs.low + "× and <strong>stays there until the position exits and re-enters</strong> — a one-way ratchet. The live S&amp;P strategy works this way (20d, 22%, 5×→3×)."
        : "<strong>Unlatched:</strong> while invested it follows vol both ways — " + gs.low + "× whenever vol is " + g + " or more, back to " + gs.high + "× once it falls below.")
      + (state.params.out > 0 ? " While out (below the SMA, or waiting for vol to calm) it holds <strong>" + state.params.out + "×</strong> instead of cash." : "")
      + " Vol is annualised from daily log returns. Each change of leverage is a trade and pays slippage.";
  }

  // Asset / period / grid / colour / slippage — the settings that are about the
  // sweep, not about the strategy itself.
  function controlsHTML() {
    return '<div class="exp-controls">'
      + '<div class="exp-ctl"><label>Asset</label><div class="winbtns">'
      + btnRow(ASSETS.map(function (a) { return { label: a.label, key: a.key }; }),
               function (it) { return it.key === state.asset; },
               function (it) { return 'data-asset="' + it.key + '"'; })
      + '</div></div>'
      + '<div class="exp-ctl"><label>Period</label><div class="winbtns">'
      + btnRow(PERIODS.map(function (p, i) { return { label: p.label, i: i }; }),
               function (it) { return it.i === state.periodIdx; },
               function (it) { return 'data-period="' + it.i + '"'; })
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
      + '<div class="exp-ctl"><label>Slippage tier</label><div class="winbtns">'
      + btnRow(SLIPPAGE_TIERS.map(function (t) { return { label: t.charAt(0).toUpperCase() + t.slice(1), t: t }; }),
               function (it) { return it.t === SC.session.slippageTier; },
               function (it) { return 'data-slip="' + it.t + '"'; })
      + '</div></div>'
      + '</div>';
  }

  // The current strategy, as editable fields. Anything a matrix does not vary
  // is read from here; clicking a matrix cell writes into here.
  function paramBarHTML(costs, gs) {
    var asset = assetConfig(state.asset), p = state.params, gated = isGated(asset);

    function field(key, inner) {
      var dim = PARAMS[key].gated && !gated;
      return '<div class="pb-field' + (dim ? " dim" : "") + '"' + (dim ? ' title="Only used when sizing is vol-gated"' : "") + '>'
        + '<label>' + PARAMS[key].label + '</label>' + inner + '</div>';
    }
    function num(key) {
      var n = PARAMS[key].num, dis = PARAMS[key].gated && !gated;
      return '<input type="number" data-param="' + key + '" value="' + p[key] + '" min="' + n.min + '" max="' + n.max + '" step="' + n.step + '"' + (dis ? " disabled" : "") + '>';
    }
    function select(key, values, disabledFn) {
      var dis = PARAMS[key].gated && !gated;
      return '<select data-param="' + key + '"' + (dis ? " disabled" : "") + '>' + values.map(function (v) {
        var off = disabledFn && disabledFn(v);
        return '<option value="' + v + '"' + (v === p[key] ? " selected" : "") + (off ? " disabled" : "") + '>' + PARAMS[key].fmt(v) + (off ? (key === "out" ? " (not below the lowest held above)" : " (no product)") : "") + '</option>';
      }).join("") + '</select>';
    }

    var sizing = '<div class="pb-field"><label>Sizing</label><div class="winbtns">'
      + btnRow([{ label: "Fixed leverage", s: "fixed" }, { label: "Vol-gated", s: "gated" }],
               function (it) { return it.s === state.sizing; },
               function (it) { return 'data-sizing="' + it.s + '"' + (it.s === "gated" && !asset.gate ? " disabled" : ""); },
               function (it) { return it.s === "gated" && !asset.gate ? asset.label + " has no leveraged product, so there is no leverage to gate." : null; })
      + '</div></div>';

    var lows = ALL_LEVERAGES.filter(function (l) { return l < Math.max(p.high, 2); });
    var ceil = minAbove(p, asset);
    var outs = OUT_LEVERAGES.filter(function (l) { return l <= costs.maxLeverage; });
    var note = "";
    if (state.sizing === "gated" && !gs.enabled) {
      note = '<div class="toolsrow">Vol gating needs a start leverage above 1× — ' + (asset.gate ? 'pick 2×, 3× or 5×.' : asset.label + ' has no leveraged product, so there is nothing to gate.') + ' Showing fixed leverage.</div>';
    }
    return '<div class="param-bar-head"><strong>Current strategy</strong>'
      + '<span class="toolsrow" style="margin:0;">Edit here, or click any matrix cell below to set its two parameters.</span>'
      + '<button class="winbtn" data-save-cfg="1" title="Save this strategy to the Evaluator tab to compare it across time periods">Save to Evaluator</button>'
      + (asset.live ? '<button class="winbtn" data-reset-live="1" title="Set every parameter to the live strategy">Reset to live strategy</button>' : "")
      + '<span class="save-msg" id="save-msg"></span>'
      + '</div>'
      + '<div class="param-bar">'
      + sizing
      + field("sma", num("sma")) + field("buffer", num("buffer"))
      + field("high", select("high", ALL_LEVERAGES, function (l) { return l > costs.maxLeverage; }))
      + field("low", select("low", lows))
      + field("out", select("out", outs, function (l) { return l >= ceil; }))
      + field("volwin", num("volwin")) + field("gate", num("gate"))
      + field("latch", select("latch", [true, false]))
      + '</div>' + note
      + (gs.enabled ? '<div class="toolsrow">' + gateSummary(gs) + '</div>' : "");
  }

  // Headline fee tiles + history chart (js/fee-chart.js), from the same product
  // fields and reference series the backtest uses.
  function feeBoxHTML(cfg, refRates, prices, period, gs) {
    var L = state.params.high;
    var prod = window.CostModel.pickProduct(cfg.products, L);
    var rate = refSeriesFn(refRates, cfg.financingRateAsset);
    var div = cfg.dividends || {};
    var divFn = div.series ? refSeriesFn(refRates, div.series).fn : (div.constantPct ? function () { return div.constantPct; } : null);
    function engineOf(p) { return { mgmtFeePct: p.mgmtFeePct, dailySwapRatePct: p.dailySwapRatePct, fundingSpreadPct: p.fundingSpreadPct + p.basisPct }; }
    var b = periodBounds(prices, period);
    var from = prices[Math.max(0, b.lo)].date, to = prices[b.hi].date;
    var lowProd = gs.enabled ? window.CostModel.pickProduct(cfg.products, gs.low) : null;
    return window.FeeChart.render({
      primary: { exposure: L, product: engineOf(prod) },
      secondary: gs.enabled ? { exposure: gs.low, product: engineOf(lowProd) } : null,
      rateFn: cfg.financingRateAsset ? rate.fn : null, rateName: cfg.financingRateAsset,
      rateNow: rate.loaded ? rate.latestValue : 0, rateNowMonth: rate.latest,
      rateEarliest: rate.loaded ? rate.earliest : null,
      divFn: divFn, from: from, to: to,
      productName: prod.name, quotedCharge: prod.mgmtFeePct + prod.dailySwapRatePct * 360
    });
  }

  function costsPanelHTML(cfg, refRates, prices, period, gs) {
    var L = state.params.high;
    var prod = window.CostModel.pickProduct(cfg.products, L);
    var rate = refSeriesFn(refRates, cfg.financingRateAsset);
    var rateNow = cfg.financingRateAsset && rate.loaded ? rate.latestValue : 0;
    var div = cfg.dividends || {};
    var divSeries = div.series ? refSeriesFn(refRates, div.series) : null;
    var divNow = divSeries ? divSeries.latestValue : (div.constantPct || 0);
    var engineProd = { mgmtFeePct: prod.mgmtFeePct, dailySwapRatePct: prod.dailySwapRatePct, fundingSpreadPct: prod.fundingSpreadPct + prod.basisPct };
    var drag = window.CostModel.annualDrag(L, rateNow, engineProd);
    var borrowed = Math.max(0, L - 1);

    function row(label, id, value, step, conf, hint) {
      return '<div class="cost-row"><label>' + label + '</label>'
        + '<input type="number" step="' + step + '" min="0" id="' + id + '" value="' + value + '"> ' + confBadge(conf)
        + (hint ? '<span class="toolsrow" style="margin:4px 0 0;">' + hint + '</span>' : '') + '</div>';
    }
    var viaNote = prod.leverage !== L ? ' (' + L + '× is held via the ' + prod.leverage + '× product — the smallest one that reaches it)' : '';

    var ladder = cfg.products.map(function (p) {
      return '<li>' + p.leverage + '×: ' + (p.source && p.source.url ? '<a href="' + p.source.url + '" target="_blank" rel="noopener">' + p.name + '</a>' : p.name)
        + (p.isin ? ' <span class="src-date">' + p.isin + '</span>' : '')
        + (p.source && p.source.fetched ? ' <span class="src-date">(fetched ' + p.source.fetched + ')</span>' : '') + '</li>';
    }).join("");

    var costLine = borrowed > 0
      ? 'At <strong>' + L + '×</strong>, with ' + cfg.financingRateAsset + ' at ' + fmt(rateNow, 2) + '% (' + (rate.latest || "latest month") + '): fees <strong>' + fmt(drag.chargesPct, 2) + '%</strong> + financing '
        + fmt(borrowed, 0) + ' borrowed × (' + fmt(rateNow, 2) + '% + ' + fmt(prod.fundingSpreadPct + prod.basisPct, 2) + '% spread) = <strong>' + fmt(drag.financingPct, 2) + '%</strong>'
        + ' → <strong>' + fmt(drag.totalPct, 2) + '% a year</strong> while invested.'
        + (divNow ? ' The underlying’s ' + fmt(divNow, 2) + '% dividend yield × ' + L + ' = ' + fmt(divNow * L, 1) + '% flows back to you, so the net carry is ' + fmt(divNow * L - drag.totalPct, 1) + '% a year before price moves.' : '')
      : 'At <strong>' + L + '×</strong> (unleveraged): fees <strong>' + fmt(drag.chargesPct, 2) + '%</strong> a year, no financing.' + (divNow ? ' The ' + fmt(divNow, 2) + '% dividend yield flows back to you.' : '');

    var formula = '<details class="toolsrow"><summary><strong>How each day is calculated</strong> (the WisdomTree prospectus formula)</summary>'
      + '<div style="margin-top:6px;line-height:1.55">'
      + 'growth = (1 + R) × (1 − CA)<br>'
      + 'R = L × (price return + dividend yield × D/365) − (L−1) × (' + (cfg.financingRateAsset || "rate") + ' + funding spread) × D/360<br>'
      + 'CA = management fee × D/360 + daily swap rate × D<br>'
      + 'D = calendar days since the previous row (3 over a weekend). It is the only number that touches time, so a 365-day asset and a 252-day asset both pay the same per year.<br>'
      + 'Slippage is separate: a one-off haircut each time the position changes. Ruin is separate too: if a day’s growth is zero or less, equity is wiped out and stays there.<br>'
      + 'The maths is in <code>js/cost-model.js</code> (about 30 lines); the inputs are in <code>cost-assumptions.json</code>. '
      + 'Run <code>python tools/check_leveraged_products.py</code> to re-test the formula against the real products’ price history.'
      + '</div></details>';

    var notes = [];
    if (prod.indexNote) notes.push('<strong>Index / rates:</strong> ' + prod.indexNote);
    if (prod.finalTermsFields) notes.push('<strong>From the Final Terms:</strong> ' + prod.finalTermsFields);
    if (prod.basisNote) notes.push('<strong>About the extra basis:</strong> ' + prod.basisNote);
    if (prod.note) notes.push('<strong>Caveat:</strong> ' + prod.note);
    if (prod.crossCheck) notes.push('<strong>Checked against the real product:</strong> ' + prod.crossCheck);
    cfg.crossChecks.forEach(function (c) { notes.push('<strong>Also checked:</strong> ' + c); });
    var notesHtml = notes.map(function (n) { return '<div class="toolsrow">' + n + '</div>'; }).join("");

    var refNote = '';
    if (cfg.financingRateAsset) {
      refNote = '<div class="toolsrow">' + (rate.loaded
        ? cfg.financingRateAsset + ' history (monthly averages, ' + rate.earliest + ' → ' + rate.latest + ') comes from <code>reference-rates.json</code>, built from ' + refRates[cfg.financingRateAsset].source
        : '<strong>' + cfg.financingRateAsset + ' data missing from reference-rates.json</strong> — financing is being modelled with a 0% base rate, which understates cost.') + '</div>';
    }
    var divNote = '<div class="toolsrow"><strong>Dividends:</strong> ' + (div.series ? 'yield from <code>reference-rates.json</code> (' + div.series + ', monthly). ' : (div.constantPct ? 'a flat ' + fmt(div.constantPct, 1) + '% yield. ' : 'none. ')) + confBadge(div.confidence || "assumed") + ' ' + (div.why || '') + '</div>';

    return '<div class="panel">'
      + '<h2>Costs — ' + assetConfig(state.asset).label + '</h2>'
      + feeBoxHTML(cfg, refRates, prices, period, gs)
      + '<div class="toolsrow"><strong>Product held at ' + L + '×:</strong> ' + (prod.source && prod.source.url ? '<a href="' + prod.source.url + '" target="_blank" rel="noopener">' + prod.name + '</a>' : prod.name) + viaNote + '</div>'
      + '<div class="cost-grid">'
      + row('Management fee (% a year)', 'cost-mgmt', fmt(prod.mgmtFeePct, 3), 0.01, prod.confidence.mgmtFeePct)
      + row('Daily swap rate (% <em>per day</em>)', 'cost-swap', fmt(prod.dailySwapRatePct, 5), 0.00001, prod.confidence.dailySwapRatePct,
            prod.dailySwapRatePct ? '= ' + fmt(prod.dailySwapRatePct * 365, 2) + '% a year, charged whatever the leverage.' : '')
      + (borrowed > 0
        ? row('Funding spread (% a year per borrowed unit)', 'cost-spread', fmt(prod.fundingSpreadPct, 3), 0.01, prod.confidence.fundingSpreadPct,
              cfg.financingRateAsset ? 'Paid on top of ' + cfg.financingRateAsset + ' for each of the ' + fmt(borrowed, 0) + ' borrowed unit(s).' : '')
          + row('Extra financing basis (% a year per borrowed unit)', 'cost-basis', fmt(prod.basisPct, 3), 0.01, prod.confidence.basisPct,
              prod.basisPct ? 'Not in any Final Terms — an empirical allowance; see the note below.' : 'Not in any Final Terms; zero unless evidence says otherwise.')
        : '')
      + '<div class="cost-row"><label>Slippage, round trip (bps) — ' + SC.session.slippageTier + ' tier</label>'
      + '<span class="cost-static">' + fmt(cfg.slippageBpsRoundTrip, 0) + ' bps</span> ' + confBadge(cfg.slippageConfidence) + '</div>'
      + '</div>'
      + '<div class="toolsrow">' + costLine + '</div>'
      + (cfg.slippageNote ? '<div class="toolsrow">' + cfg.slippageNote + '</div>' : "")
      + divNote + refNote + notesHtml + formula
      + '<div class="toolsrow"><strong>Products this asset can be held through:</strong><ul class="src-list">' + ladder + '</ul></div>'
      + '<div class="toolsrow">Edited values apply for this session only and reset on reload.</div>'
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
      + ' Net of costs. Ruined combos are excluded from the scale.</span>'
      + '</div>';
  }

  function cellTitle(desc, s) {
    if (s.invalid) return desc + " — not runnable: " + s.invalid;
    if (s.insufficient) return desc + " — not enough history in this period";
    if (s.ruined) {
      return desc + " — WIPED OUT" + (s.ruinDate ? " on " + s.ruinDate : "")
        + "\nA single bad day at this leverage, plus costs, destroys the position.";
    }
    return desc + " (net of costs)"
      + "\nCAGR " + fmt(s.cagr, 1) + "%   max drawdown " + fmt(s.maxDD, 1) + "%"
      + "\nCalmar " + (s.calmar == null ? "—" : fmt(s.calmar, 2))
      + "\n" + fmt(s.tradesPerYear, 1) + " round trips/yr over " + fmt(s.years, 1) + " years";
  }

  function metricValue(s) {
    if (!s || s.invalid || s.insufficient || s.ruined) return null;
    return state.metric === "calmar" ? s.calmar : s.cagr;
  }

  // Does this parameter set match the live strategy? (Fixed sizing only compares
  // what fixed sizing uses.)
  function isLiveSet(asset, p) {
    if (!asset.live) return false;
    var gated = isGated();
    var keys = gated && asset.live.sizing === "gated" ? PARAM_ORDER : ["sma", "buffer", "out"];
    if (gated !== (asset.live.sizing === "gated") && keys.length > 3) return false;
    return keys.every(function (k) { return p[k] === asset.live.params[k]; });
  }

  function axisSelect(idx, axis, current, other) {
    return '<select data-mx="' + idx + '" data-axis="' + axis + '">'
      + PARAM_ORDER.map(function (k) {
        return '<option value="' + k + '"' + (k === current ? " selected" : "") + '>' + PARAMS[k].label + (PARAMS[k].gated ? " (vol-gated)" : "") + '</option>';
      }).join("") + '</select>';
  }

  function matrixHTML(idx, m, env) {
    var asset = env.asset, costs = env.costs;
    var head = '<div class="mx-head"><strong>Matrix ' + (idx + 1) + '</strong>'
      + '<label>Y <span class="mx-axis">↓</span>' + axisSelect(idx, "y", m.y, m.x) + '</label>'
      + '<label>X <span class="mx-axis">→</span>' + axisSelect(idx, "x", m.x, m.y) + '</label>'
      + (idx > 0 ? '<button class="winbtn" data-rmm="' + idx + '" title="Remove this matrix">✕</button>' : "")
      + '</div>';

    if ((PARAMS[m.x].gated || PARAMS[m.y].gated) && !isGated(asset)) {
      return '<div class="matrix-card">' + head + '<div class="toolsrow">This matrix varies a vol-gate parameter, which only applies when sizing is vol-gated. '
        + (asset.gate ? '<button class="winbtn" data-sizing="gated">Switch to vol-gated</button>' : asset.label + ' has no leveraged product, so there is nothing to gate.') + '</div></div>';
    }
    var xs = axisValues(m.x, asset, costs), ys = axisValues(m.y, asset, costs);
    if (!xs.length || !ys.length) {
      return '<div class="matrix-card">' + head + '<div class="toolsrow">No values to show on this axis for ' + asset.label + '.</div></div>';
    }

    var cells = ys.map(function (yv) {
      return xs.map(function (xv) {
        var p = Object.assign({}, state.params); p[m.x] = xv; p[m.y] = yv;
        return { p: p, s: cellStats(env, p) };
      });
    });
    var maxAbs = 0, ruined = 0, total = 0;
    cells.forEach(function (row) {
      row.forEach(function (c) {
        var v = metricValue(c.s);
        if (v != null && isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
        if (!c.s.invalid) { total++; if (c.s.ruined) ruined++; }
      });
    });

    var thead = '<tr><th class="corner">' + PARAMS[m.y].short + ' \\ ' + PARAMS[m.x].short + '</th>'
      + xs.map(function (xv) { return '<th>' + PARAMS[m.x].fmt(xv) + '</th>'; }).join("") + '</tr>';
    var tbody = ys.map(function (yv, r) {
      return '<tr><th>' + PARAMS[m.y].fmt(yv) + '</th>' + xs.map(function (xv, c) {
        var cell = cells[r][c], s = cell.s;
        var gs = (resolve(cell.p, costs).gs) || { enabled: false };
        var isSel = state.params[m.x] === xv && state.params[m.y] === yv;
        var cls, inner;
        if (s.invalid) { cls = "cell-na"; inner = '<span class="c-main">—</span>'; }
        else if (s.insufficient) { cls = "cell-na"; inner = '<span class="c-main">—</span>'; }
        else if (s.ruined) {
          cls = "cell-ruined";
          inner = '<span class="c-main">RUINED</span><span class="c-sub">' + (s.ruinDate ? s.ruinDate.slice(0, 4) : "pre-period") + '</span>';
        } else {
          cls = rampClass(metricValue(s), maxAbs);
          inner = '<span class="c-main">' + (s.cagr >= 0 ? "+" : "") + fmt(s.cagr, 1) + '%</span><span class="c-sub">' + fmt(s.maxDD, 1) + '%</span>';
        }
        return '<td class="mcell ' + cls + (isLiveSet(asset, cell.p) ? " is-live" : "") + (isSel ? " is-sel" : "") + '"'
          + (s.invalid ? "" : ' tabindex="0" role="button" data-m="' + idx + '" data-xv="' + xv + '" data-yv="' + yv + '"')
          + ' title="' + cellTitle(describeStrategy(cell.p, gs), s).replace(/"/g, "&quot;") + '">' + inner + '</td>';
      }).join("") + '</tr>';
    }).join("");

    return '<div class="matrix-card">' + head + legendHTML(maxAbs)
      + '<div class="matrixwrap"><table class="matrix"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>'
      + '<div class="toolsrow">Each cell: <strong>CAGR</strong> on top, <strong>max drawdown</strong> below. '
      + (ruined ? '<strong>' + ruined + ' of ' + total + ' were wiped out</strong> (costs included). ' : 'None wiped out. ')
      + 'Held constant here: ' + PARAM_ORDER.filter(function (k) { return k !== m.x && k !== m.y && (!PARAMS[k].gated || isGated(asset)); })
        .map(function (k) { return PARAMS[k].short.toLowerCase() + " " + PARAMS[k].fmt(state.params[k]); }).join(", ") + '.</div>'
      + '</div>';
  }

  function summaryHTML(s, gs) {
    function tile(k, v, sub) { return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (sub ? '<div class="k" style="margin:3px 0 0;">' + sub + '</div>' : "") + '</div>'; }
    if (s.invalid) return '<div class="toolsrow">This combination cannot run: ' + s.invalid + '.</div>';
    if (s.insufficient) return '<div class="toolsrow">Not enough history in this period for the current strategy.</div>';
    if (s.ruined) return '<div class="statrow"><div class="stat"><div class="k">Result</div><div class="v" style="color:var(--warn)">WIPED OUT' + (s.ruinDate ? " " + s.ruinDate.slice(0, 4) : "") + '</div></div></div>';
    return '<div class="statrow" style="grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));">'
      + tile("CAGR (net)", (s.cagr >= 0 ? "+" : "") + fmt(s.cagr, 1) + "%", s.from + " → " + s.to)
      + tile("Max drawdown", fmt(s.maxDD, 1) + "%")
      + tile("Calmar", s.calmar == null ? "—" : fmt(s.calmar, 2))
      + tile("Round trips / yr", fmt(s.tradesPerYear, 1))
      + '</div>';
  }

  // Gross-to-net breakdown for the selected cell only. Each column switches on
  // ONE more cost than the column before it (dividends in, then fees, then
  // financing, then slippage), so every step is checkable by eye and the last
  // column is the same net figure the matrix and charts show.
  function costBreakdownHTML(prices, wk, period, leverage, ec) {
    var steps = [
      ["Price only, no costs", { dividends: false, charges: false, financing: false, slippage: false }],
      ["+ dividends", { dividends: true, charges: false, financing: false, slippage: false }],
      ["− fees", { dividends: true, charges: true, financing: false, slippage: false }],
      ["− financing", { dividends: true, charges: true, financing: true, slippage: false }],
      ["− slippage = Net", { dividends: true, charges: true, financing: true, slippage: true }]
    ].map(function (st) { return { label: st[0], s: windowStats(prices, wk, period, leverage, costVariant(ec, st[1])) }; });

    function cell(label, s) {
      var v = (s && !s.insufficient) ? s.cagr : null;
      return '<div class="stat"><div class="k">' + label + '</div><div class="v">' + (v == null ? "—" : (v >= 0 ? "+" : "") + fmt(v, 1) + "%") + '</div></div>';
    }
    var gross = steps[0].s, net = steps[4].s;
    return '<div class="panel">'
      + '<h2>Cost breakdown — this cell, this period (CAGR)</h2>'
      + '<div class="statrow" style="grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));">'
      + steps.map(function (st) { return cell(st.label, st.s); }).join("")
      + '</div>'
      + '<div class="toolsrow">Left to right, each column switches on one more cost. Max drawdown: <strong>' + (net.insufficient ? "—" : fmt(net.maxDD, 1) + "%") + '</strong> net vs <strong>' + (gross.insufficient ? "—" : fmt(gross.maxDD, 1) + "%") + '</strong> price-only. Dividends can push the second column above the first; leverage multiplies them just as it multiplies price moves.</div>'
      + '</div>';
  }

  function renderMain(container, data, costAssumptions, refRates) {
    var asset = assetConfig(state.asset);
    var prices = data[window.App.assetKey(asset.backtestAsset)];
    var costs = curCosts = costConfigFor(costAssumptions, state.asset);
    normalizeParams(asset, costs);

    if (!prices || !prices.length) {
      container.innerHTML = '<div class="panel"><h2>Strategy Explorer</h2>' + controlsHTML()
        + '<div class="fatal">No ' + asset.backtestAsset + ' data loaded yet for ' + asset.label
        + '. Use the <strong>Data</strong> section at the bottom of this tab (Twelve Data refresh) to bring in its history.</div></div>';
      wire(container, data, costAssumptions, refRates);
      return;
    }

    var ec = engineCostsFrom(costs, refRates);
    var period = PERIODS[state.periodIdx];
    var env = {
      prices: prices, asset: asset, costs: costs, ec: ec, period: period,
      stamp: asset.key + "|" + prices.length + "|" + prices[prices.length - 1].date,
      costSig: JSON.stringify([asset.key, ec.products, ec.slippageBpsRoundTrip])
    };
    var gs = gateSettings();
    var cur = cellStats(env, state.params);

    var html = '<div class="panel">'
      + '<h2>Strategy Explorer — ' + asset.label + '</h2>'
      + controlsHTML()
      + paramBarHTML(costs, gs)
      + summaryHTML(cur, gs)
      + '</div>';

    html += '<div class="panel"><h2>Design space</h2>'
      + '<div class="toolsrow" style="margin-top:0;">Each matrix varies two parameters (choose them with the dropdowns); every other parameter comes from the current strategy above. '
      + '<strong>Click a cell to make it the current strategy</strong> — the other matrices, the summary and the charts below all update to it. '
      + (asset.live ? 'The ringed cell is the live strategy. ' : "")
      + '"Below the SMA" is what you hold while out — cash, or 1×/2×/3× instead. '
      + 'Backtested on ' + asset.backtestAsset + '. Each period is compounded fresh from its own start, so RUINED means wiped out <em>inside</em> the selected window; the in/out signal still carries in from before it.</div>'
      + '<div class="matrix-stack">'
      + state.matrices.map(function (m, i) { return matrixHTML(i, m, env); }).join("")
      + '</div>'
      + (state.matrices.length < MAX_MATRICES ? '<button class="winbtn" data-addm="1">+ Add matrix</button>' : "")
      + '</div>';

    html += costsPanelHTML(costs, refRates, prices, period, gs);

    var wk = walkFor(prices, asset.key, state.params.sma, state.params.buffer, gs, { out: state.params.out, high: state.params.high });
    var sel = { sma: state.params.sma, buffer: state.params.buffer };
    html += window.PriceChart.render(prices, sel, state.params.high, period, wk);
    html += costBreakdownHTML(prices, wk, period, state.params.high, ec);
    html += window.PerfChart.render(prices, sel, state.params.high, period, wk, state.perfMode, state.annMode, ec);

    container.innerHTML = html;
    wire(container, data, costAssumptions, refRates);
  }

  function wire(container, data, costAssumptions, refRates) {
    function rerender() { renderMain(container, data, costAssumptions, refRates); }
    function bind(sel, fn) {
      container.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function () { if (el.disabled) return; fn(el); rerender(); });
      });
    }
    bind("[data-asset]", function (el) {
      state.asset = el.getAttribute("data-asset");
      var a = assetConfig(state.asset);
      if (a.gate) state.params.gate = a.gate.def;    // each asset has its own vol scale
    });
    bind("[data-period]", function (el) { state.periodIdx = Number(el.getAttribute("data-period")); });
    bind("[data-sizing]", function (el) { state.sizing = el.getAttribute("data-sizing"); });
    bind("[data-grid]", function (el) { state.grid = el.getAttribute("data-grid"); });
    bind("[data-metric]", function (el) { state.metric = el.getAttribute("data-metric"); });
    bind("[data-slip]", function (el) { SC.session.slippageTier = el.getAttribute("data-slip"); });
    bind("[data-perf]", function (el) { state.perfMode = el.getAttribute("data-perf"); });
    bind("[data-ann]", function (el) { state.annMode = el.getAttribute("data-ann"); });
    bind("[data-reset-live]", function () {
      var live = assetConfig(state.asset).live;
      if (!live) return;
      Object.keys(live.params).forEach(function (k) { state.params[k] = live.params[k]; });
      state.sizing = live.sizing;
    });
    var saveBtn = container.querySelector("[data-save-cfg]");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      var msg = container.querySelector("#save-msg");
      var gs = gateSettings();
      var res = SC.save(curCfg(), SC.describe(curCfg(), gs));
      msg.className = "save-msg " + (res.error ? "err" : "ok");
      msg.textContent = res.error || ("Saved — see the Evaluator tab (" + SC.saved().length + " of " + SC.MAX_SAVED + ").");
      if (!res.error && window.App.refreshEvaluator) window.App.refreshEvaluator();
    });

    bind("[data-addm]", function () {
      if (state.matrices.length >= MAX_MATRICES) return;
      var used = state.matrices.map(function (m) { return m.x + "/" + m.y; });
      var next = NEW_MATRIX_DEFAULTS.filter(function (d) { return used.indexOf(d.x + "/" + d.y) < 0; })[0] || { x: "buffer", y: "sma" };
      state.matrices.push({ x: next.x, y: next.y });
    });
    bind("[data-rmm]", function (el) { state.matrices.splice(Number(el.getAttribute("data-rmm")), 1); });

    // Parameter bar fields.
    container.querySelectorAll("[data-param]").forEach(function (el) {
      el.addEventListener("change", function () {
        var key = el.getAttribute("data-param"), v = parseVal(key, el.value);
        var n = PARAMS[key].num;
        if (key !== "latch" && (!isFinite(v) || (n && (v < n.min || v > n.max)))) return rerender(); // reject junk, snap back
        state.params[key] = v;
        rerender();
      });
    });

    // Matrix axis dropdowns. Picking the other axis's parameter swaps the two;
    // picking a vol-gate parameter switches sizing to vol-gated (you clearly want it).
    container.querySelectorAll("[data-mx]").forEach(function (el) {
      el.addEventListener("change", function () {
        var m = state.matrices[Number(el.getAttribute("data-mx"))], axis = el.getAttribute("data-axis"), other = axis === "x" ? "y" : "x";
        var val = el.value;
        if (val === m[other]) m[other] = m[axis];
        m[axis] = val;
        if ((PARAMS[m.x].gated || PARAMS[m.y].gated) && assetConfig(state.asset).gate) state.sizing = "gated";
        rerender();
      });
    });

    // Cost edits apply to the product held at the current start leverage.
    var costCfg = costConfigFor(costAssumptions, state.asset);
    var heldProduct = window.CostModel.pickProduct(costCfg.products, state.params.high);
    [["#cost-mgmt", "mgmtFeePct"], ["#cost-swap", "dailySwapRatePct"], ["#cost-spread", "fundingSpreadPct"], ["#cost-basis", "basisPct"]].forEach(function (pair) {
      var input = container.querySelector(pair[0]);
      if (!input || !heldProduct) return;
      input.addEventListener("change", function () {
        var perAsset = SC.session.costOverrides[state.asset] = SC.session.costOverrides[state.asset] || {};
        var perProduct = perAsset[heldProduct.leverage] = perAsset[heldProduct.leverage] || {};
        perProduct[pair[1]] = Math.max(0, parseFloat(input.value) || 0);
        rerender();
      });
    });

    // Clicking a matrix cell sets that matrix's two parameters on the current strategy.
    container.querySelectorAll(".mcell[data-m]").forEach(function (cell) {
      function pick() {
        var m = state.matrices[Number(cell.getAttribute("data-m"))];
        if (!m) return;
        state.params[m.x] = parseVal(m.x, cell.getAttribute("data-xv"));
        state.params[m.y] = parseVal(m.y, cell.getAttribute("data-yv"));
        rerender();
      }
      cell.addEventListener("click", pick);
      cell.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
    });
  }

  // --- data section (auto import) --------------------------------------
  // The Twelve Data refresh lives here as well as on the Developed tab, so the
  // explorer's assets (especially Gold / Nasdaq / FTSE, which start empty) can
  // be brought up to date without leaving the tab.
  function dataPanelHTML(data) {
    var today = Date.now();
    var rows = ASSETS.map(function (a) {
      var series = data[window.App.assetKey(a.backtestAsset)] || [];
      var last = series.length ? series[series.length - 1].date : null;
      var behind = last ? Math.round((today - new Date(last + "T00:00:00Z").getTime()) / 86400000) : null;
      return '<tr><td>' + a.label + '</td><td>' + a.backtestAsset + '</td>'
        + '<td class="num">' + (series.length ? series.length.toLocaleString() : "—") + '</td>'
        + '<td>' + (series.length ? series[0].date : "—") + '</td>'
        + '<td>' + (last || "no data yet") + '</td>'
        + '<td class="num' + (behind == null || behind > 5 ? ' stale' : '') + '">' + (behind == null ? "import needed" : behind <= 1 ? "current" : behind + " days behind") + '</td></tr>';
    }).join("");
    return '<div class="panel">'
      + '<h2>Data — auto import</h2>'
      + '<div class="matrixwrap"><table class="datatable"><thead><tr><th>Asset</th><th>Series</th><th>Rows</th><th>From</th><th>Latest</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="toolsrow">Refreshing pulls each asset from Twelve Data — BTC, SPY (the S&amp;P; its new days are converted into <code>SPX_MERGED</code>), Gold, Nasdaq 100 (via QQQ) and FTSE 100 (via S100) — and shows a preview before anything is saved. '
      + 'An asset with no rows yet backfills its full available history. Fees, financing and dividend reference data (<code>reference-rates.json</code>) are static and are not touched here.</div>'
      + '</div>'
      + window.ImportTools.refreshPanelHTML();
  }

  // Public entry point. The explorer's own controls re-render only #exp-main,
  // so a half-finished import preview in #exp-data survives clicking around.
  function render(container, data, costAssumptions, refRates, ctx) {
    var main = container.querySelector("#exp-main");
    if (!main) {
      container.innerHTML = '<div id="exp-main"></div><div id="exp-data"></div>';
      main = container.querySelector("#exp-main");
    }
    renderMain(main, data, costAssumptions, refRates);
    var dataEl = container.querySelector("#exp-data");
    dataEl.innerHTML = dataPanelHTML(data);
    if (ctx) window.ImportTools.wireUp(dataEl, ctx);
  }

  return { render: render };
})();
