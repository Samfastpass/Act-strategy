// Strategy Explorer (formerly the S&P Leverage explorer) — a general explorer
// across five assets. Sweeps a trend strategy — in at a leverage, out to cash —
// across a grid of SMA lengths (rows) and symmetric buffers (columns), with a
// real, sourced cost model (fees, financing, slippage) applied throughout.
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

  var ASSETS = [
    // gate: the vol-gate thresholds offered (annualised vol, %) and the
    // default. S&P's 22% is the live strategy's; the others are round numbers
    // around each asset's typical vol, NOT tuned — no live strategy exists.
    // BTC has no leveraged product, so there is nothing to gate.
    { key: "SP500", label: "S&P 500", backtestAsset: "SPX_MERGED", live: { sma: 200, buffer: 3 }, gate: { options: [16, 18, 20, 22, 25, 30], def: 22 } },
    { key: "BTC", label: "Bitcoin", backtestAsset: "BTC", live: null, gate: null },
    { key: "GOLD", label: "Gold", backtestAsset: "GOLD", live: null, gate: { options: [10, 12, 15, 18, 22], def: 15 } },
    { key: "NASDAQ100", label: "Nasdaq 100", backtestAsset: "NASDAQ100", live: null, gate: { options: [18, 22, 26, 30, 35], def: 26 } },
    { key: "FTSE100", label: "FTSE 100", backtestAsset: "FTSE100", live: null, gate: { options: [12, 14, 16, 18, 22], def: 16 } }
  ];
  var VOL_WINDOWS = [10, 20, 30, 60];

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

  var state = {
    asset: "SP500", periodIdx: 0, leverage: 5, grid: "broad", metric: "calmar", selected: null,
    sizing: "fixed", latch: true, volLen: 20, gate: {}, downTo: null, // gate: assetKey -> chosen threshold %
    perfMode: "total", annMode: "calendar", slippageTier: "medium",
    costOverrides: {} // assetKey -> { productLeverage -> { mgmtFeePct, dailySwapRatePct, fundingSpreadPct, basisPct } } once user edits
  };
  var walkCache = {}; // stamp|sma|buffer|sizing -> { state, sma, startIdx, ... }
  var volCache = {};  // stamp|volLen -> realised-vol series, shared by every cell's walk

  function assetConfig(key) { return ASSETS.filter(function (a) { return a.key === key; })[0]; }

  // The gating settings actually in force (or { enabled: false }).
  function gateSettings() {
    var asset = assetConfig(state.asset);
    if (state.sizing !== "gated" || !asset.gate || state.leverage <= 1) return { enabled: false };
    var gatePct = state.gate[state.asset] != null ? state.gate[state.asset] : asset.gate.def;
    var opts = ALL_LEVERAGES.filter(function (l) { return l < state.leverage; });
    var low = opts.indexOf(state.downTo) >= 0 ? state.downTo : Math.max(1, state.leverage - 2);
    if (opts.indexOf(low) < 0) low = opts[opts.length - 1];
    return { enabled: true, volLen: state.volLen, gatePct: gatePct, gate: gatePct / 100,
             high: state.leverage, low: low, latch: state.latch };
  }

  function gateLabel(gs) {
    return gs.high + "×→" + gs.low + "× " + (gs.latch ? "latched" : "unlatched") + " at " + gs.volLen + "d vol ≥ " + gs.gatePct + "%";
  }

  function paramsFor(smaLen, bufferPct, gs, volSeries) {
    if (gs && gs.enabled) {
      return {
        smaLen: smaLen, buffer: bufferPct / 100,
        volLen: gs.volLen, volGate: gs.gate, annualization: 252, volSeries: volSeries,
        // Unlike the binary sweep, the walk here is done AT the real leverages:
        // when the gate trips the state changes between two non-zero levels, so
        // the walk (not the caller) decides the exposure.
        leverage: { base: gs.high, gated: gs.low }, latch: gs.latch,
        sizing: { mode: "fixedLeverage" }
      };
    }
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

  // Caches are keyed on the price series' length and last date, so importing
  // new days invalidates them instead of serving walks that are one row short.
  function walkFor(prices, assetKey, smaLen, bufferPct, gs) {
    var stamp = assetKey + "|" + prices.length + "|" + prices[prices.length - 1].date;
    var gated = gs && gs.enabled;
    var key = stamp + "|" + smaLen + "|" + bufferPct + "|"
      + (gated ? ["g", gs.volLen, gs.gatePct, gs.high, gs.low, gs.latch].join(":") : "f");
    if (walkCache[key]) return walkCache[key];
    if (Object.keys(walkCache).length > 600) { walkCache = {}; volCache = {}; }

    var volSeries = null;
    if (gated) {
      var vkey = stamp + "|" + gs.volLen;
      volCache[vkey] = volCache[vkey] || window.StrategyEngine.realizedVol(prices.map(function (p) { return p.close; }), gs.volLen, 252);
      volSeries = volCache[vkey];
    }
    var w = window.StrategyEngine.walk(prices, paramsFor(smaLen, bufferPct, gs, volSeries));
    walkCache[key] = { state: w.state, sma: w.sma, startIdx: w.startIdx, gated: !!gated,
                       high: gated ? gs.high : null, low: gated ? gs.low : null, label: gated ? gateLabel(gs) : null };
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

  // --- cost config ----------------------------------------------------
  // cost-assumptions.json lists, per asset, the real products held at each
  // leverage. Here we (1) overlay any edits the user has typed this session,
  // and (2) turn that into the plain object StrategyEngine.compoundEquity
  // wants. The fee/financing maths itself is in js/cost-model.js.
  var EDITABLE = ["mgmtFeePct", "dailySwapRatePct", "fundingSpreadPct", "basisPct"];

  function productWithEdits(assetKey, p) {
    var ov = (state.costOverrides[assetKey] || {})[p.leverage] || {};
    var out = { leverage: p.leverage, name: p.name, isin: p.isin, indexNote: p.indexNote, note: p.note,
                basisNote: p.basisNote, finalTermsFields: p.finalTermsFields, source: p.source,
                crossCheck: p.crossCheck, confidence: {} };
    EDITABLE.forEach(function (f) {
      out[f] = ov[f] != null ? ov[f] : (p[f] || 0);
      out.confidence[f] = ov[f] != null ? "edited" : ((p.confidence && p.confidence[f]) || "assumed");
    });
    return out;
  }

  function costConfigFor(costAssumptions, assetKey) {
    var base = (costAssumptions && costAssumptions[assetKey]) || {};
    return {
      maxLeverage: base.maxLeverage != null ? base.maxLeverage : 5,
      leverageRestriction: base.leverageRestriction || null,
      products: (base.products || []).map(function (p) { return productWithEdits(assetKey, p); }),
      financingRateAsset: base.financingRateAsset || null,
      dividends: base.dividends || { constantPct: 0, confidence: "assumed" },
      slippageBpsRoundTrip: (base.slippageBpsRoundTrip || { low: 0, medium: 0, high: 0 })[state.slippageTier] || 0,
      slippageConfidence: base.slippageConfidence || "assumed",
      slippageNote: base.slippageNote || "",
      crossChecks: base.crossChecks || []
    };
  }

  // Looks a month's value up in a series from reference-rates.json
  // ([ ["YYYY-MM", value], ... ]), holding the first/last value outside the
  // covered range. Returns { fn, loaded, earliest, latest, latestValue }.
  function refSeriesFn(refRates, name) {
    var ser = refRates && refRates[name] && refRates[name].series;
    if (!ser || !ser.length) return { fn: function () { return 0; }, loaded: false };
    var byMonth = {};
    ser.forEach(function (r) { byMonth[r[0]] = r[1]; });
    var first = ser[0][1], last = ser[ser.length - 1][1];
    // The backtest asks for the same month ~21 times running; remember the last
    // answer so most calls skip the hash lookup.
    var lastKey = null, lastVal = 0;
    return {
      loaded: true, earliest: ser[0][0], latest: ser[ser.length - 1][0], latestValue: last,
      fn: function (dateStr) {
        var key = dateStr.slice(0, 7);
        if (key === lastKey) return lastVal;
        var v = byMonth[key];
        if (v == null) v = key < ser[0][0] ? first : last;
        lastKey = key; lastVal = v;
        return v;
      }
    };
  }

  // The plain object compoundEquity takes. Products carry funding spread +
  // empirical basis as one number (that is all the maths needs); the split is
  // only for display.
  function engineCostsFrom(cfg, refRates) {
    var rate = refSeriesFn(refRates, cfg.financingRateAsset);
    var div = cfg.dividends || {};
    var yieldFn = div.series ? refSeriesFn(refRates, div.series).fn : (div.constantPct ? function () { return div.constantPct; } : null);
    return {
      products: cfg.products.map(function (p) {
        return { leverage: p.leverage, mgmtFeePct: p.mgmtFeePct, dailySwapRatePct: p.dailySwapRatePct,
                 fundingSpreadPct: p.fundingSpreadPct + p.basisPct };
      }),
      rateForDate: cfg.financingRateAsset ? rate.fn : function () { return 0; },
      dividendYieldForDate: yieldFn,
      slippageBpsRoundTrip: cfg.slippageBpsRoundTrip
    };
  }

  // A copy of the costs with some components switched off — used by the
  // gross-to-net breakdown so each step removes exactly one cost.
  function costVariant(ec, on) {
    var zero = function () { return 0; };
    return {
      products: ec.products.map(function (p) {
        return { leverage: p.leverage,
                 mgmtFeePct: on.charges ? p.mgmtFeePct : 0, dailySwapRatePct: on.charges ? p.dailySwapRatePct : 0,
                 fundingSpreadPct: on.financing ? p.fundingSpreadPct : 0 };
      }),
      rateForDate: on.financing ? ec.rateForDate : zero,
      dividendYieldForDate: on.dividends ? ec.dividendYieldForDate : null,
      slippageBpsRoundTrip: on.slippage ? ec.slippageBpsRoundTrip : 0
    };
  }

  // Compounds the window fresh from 1.0 at its start (capital restarts per
  // period; the in/out *state* still carries in from before, so there's no
  // artificial entry on day one). Delegates the actual compounding —
  // leverage, costs, ruin — to StrategyEngine.compoundEquity, the same core
  // used everywhere else equity gets computed in this app.
  function windowStats(prices, wk, period, leverage, costs) {
    var b = periodBounds(prices, period);
    var lo = Math.max(b.lo, wk.startIdx), hi = b.hi;
    if (hi - lo < 2) return { insufficient: true };

    var exposure = new Array(hi + 1);
    var trades = 0;
    for (var i = lo; i <= hi; i++) {
      exposure[i] = window.StrategyEngine.exposureAt(wk, i, leverage);
      if (i > lo && (exposure[i] > 0) !== (exposure[i - 1] > 0)) trades++;
    }
    var curve = window.StrategyEngine.compoundEquity(prices, exposure, lo, hi, costs);

    var last = curve[curve.length - 1];
    var years = (new Date(prices[hi].date) - new Date(prices[lo].date)) / (1000 * 60 * 60 * 24 * 365.25);
    if (years <= 0) return { insufficient: true };
    var cagr = last.equity > 0 ? (Math.pow(last.equity, 1 / years) - 1) * 100 : -100;

    var peak = 1, maxDD = 0;
    curve.forEach(function (p) {
      var v = p.equity;
      if (v > peak) peak = v;
      var dd = peak > 0 ? v / peak - 1 : -1;
      if (dd < maxDD) maxDD = dd;
    });

    return {
      cagr: cagr, maxDD: maxDD * 100,
      calmar: maxDD < 0 ? cagr / Math.abs(maxDD * 100) : null,
      ruined: !!curve.ruinedAt, ruinDate: curve.ruinedAt,
      years: years, trades: trades, tradesPerYear: trades / years,
      from: prices[lo].date, to: prices[hi].date
    };
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

  function metricValue(s) {
    if (!s || s.insufficient || s.ruined) return null;
    return state.metric === "calmar" ? s.calmar : s.cagr;
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
      + " Vol is annualised from daily log returns. Each change of leverage is a trade and pays slippage.";
  }

  function controlsHTML(costs) {
    var asset = assetConfig(state.asset);
    var gs = gateSettings();
    var leverageDisabled = function (l) {
      if (l <= costs.maxLeverage) return null;
      return costs.leverageRestriction
        ? l + "x: " + costs.leverageRestriction
        : l + "x: no real leveraged product found for " + asset.label + " at this level.";
    };
    var gatedNote = "";
    if (state.sizing === "gated" && !gs.enabled) {
      gatedNote = '<div class="toolsrow">Vol gating needs leverage above 1× to reduce — ' + (asset.gate ? 'pick 2×, 3× or 5× above.' : asset.label + ' has no leveraged product, so there is nothing to gate.') + ' Showing fixed leverage.</div>';
    }
    var gateControls = "";
    if (gs.enabled) {
      var lows = ALL_LEVERAGES.filter(function (l) { return l < gs.high; });
      gateControls = '<div class="exp-controls exp-gate">'
        + '<div class="exp-ctl"><label>Latch</label><div class="winbtns">'
        + btnRow([{ label: "Latched (one-way)", v: 1 }, { label: "Unlatched (two-way)", v: 0 }],
                 function (it) { return (it.v === 1) === gs.latch; },
                 function (it) { return 'data-latch="' + it.v + '"'; })
        + '</div></div>'
        + '<div class="exp-ctl"><label>Vol window</label><div class="winbtns">'
        + btnRow(VOL_WINDOWS.map(function (w) { return { label: w + "d", w: w }; }),
                 function (it) { return it.w === gs.volLen; },
                 function (it) { return 'data-vw="' + it.w + '"'; })
        + '</div></div>'
        + '<div class="exp-ctl"><label>Latch down when vol ≥</label><div class="winbtns">'
        + btnRow(asset.gate.options.map(function (g) { return { label: g + "%", g: g }; }),
                 function (it) { return it.g === gs.gatePct; },
                 function (it) { return 'data-gate="' + it.g + '"'; })
        + '</div></div>'
        + '<div class="exp-ctl"><label>Down to</label><div class="winbtns">'
        + btnRow(lows.map(function (l) { return { label: l + "×", l: l }; }),
                 function (it) { return it.l === gs.low; },
                 function (it) { return 'data-down="' + it.l + '"'; })
        + '</div></div>'
        + '</div>'
        + '<div class="toolsrow">' + gateSummary(gs) + '</div>';
    }
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
      + '<div class="exp-ctl"><label>' + (gs.enabled ? "High leverage" : "Leverage") + '</label><div class="winbtns">'
      + btnRow(ALL_LEVERAGES.map(function (l) { return { label: l + "x", l: l }; }),
               function (it) { return it.l === state.leverage; },
               function (it) { return 'data-lev="' + it.l + '"' + (leverageDisabled(it.l) ? " disabled" : ""); },
               function (it) { return leverageDisabled(it.l); })
      + '</div></div>'
      + '<div class="exp-ctl"><label>Sizing</label><div class="winbtns">'
      + btnRow([{ label: "Fixed leverage", s: "fixed" }, { label: "Vol-gated", s: "gated" }],
               function (it) { return it.s === state.sizing; },
               function (it) { return 'data-sizing="' + it.s + '"' + (it.s === "gated" && !asset.gate ? " disabled" : ""); },
               function (it) { return it.s === "gated" && !asset.gate ? asset.label + " has no leveraged product, so there is no leverage to gate." : null; })
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
               function (it) { return it.t === state.slippageTier; },
               function (it) { return 'data-slip="' + it.t + '"'; })
      + '</div></div>'
      + '</div>' + gatedNote + gateControls;
  }

  // Headline fee tiles + history chart (js/fee-chart.js), from the same product
  // fields and reference series the backtest uses.
  function feeBoxHTML(cfg, refRates, prices, period, gs) {
    var L = state.leverage;
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
    var L = state.leverage;
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
      + '<div class="cost-row"><label>Slippage, round trip (bps) — ' + state.slippageTier + ' tier</label>'
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
      + ' Net of the costs above. Ruined combos are excluded from the scale.</span>'
      + '</div>';
  }

  function cellTitle(sma, buf, s) {
    if (!s || s.insufficient) return sma + "d / " + buf + "% — not enough history in this period";
    if (s.ruined) {
      return sma + "d / " + buf + "% — WIPED OUT" + (s.ruinDate ? " on " + s.ruinDate : "")
        + "\nAt " + state.leverage + "x plus costs, a single bad day destroys the position.";
    }
    return sma + "d SMA / " + buf + "% buffer (net of costs)"
      + "\nCAGR " + fmt(s.cagr, 1) + "%   max drawdown " + fmt(s.maxDD, 1) + "%"
      + "\nCalmar " + (s.calmar == null ? "—" : fmt(s.calmar, 2))
      + "\n" + fmt(s.tradesPerYear, 1) + " round trips/yr over " + fmt(s.years, 1) + " years";
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
    if (!prices || !prices.length) {
      container.innerHTML = '<div class="panel"><h2>Strategy Explorer</h2>'
        + controlsHTML(costConfigFor(costAssumptions, state.asset))
        + '<div class="fatal">No ' + asset.backtestAsset + ' data loaded yet for ' + asset.label
        + '. Use the <strong>Data</strong> section at the bottom of this tab (Twelve Data refresh) to bring in its history.</div></div>';
      wire(container, data, costAssumptions, refRates);
      return;
    }

    var costs = costConfigFor(costAssumptions, state.asset);
    if (state.leverage > costs.maxLeverage) state.leverage = costs.maxLeverage;

    var ec = engineCostsFrom(costs, refRates);

    var gs = gateSettings();
    var grid = GRIDS[state.grid];
    var period = PERIODS[state.periodIdx];

    var cells = grid.smas.map(function (sma) {
      return grid.buffers.map(function (buf) {
        return windowStats(prices, walkFor(prices, asset.key, sma, buf, gs), period, state.leverage, ec);
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
        var isLive = asset.live && sma === asset.live.sma && buf === asset.live.buffer;
        var isSel = state.selected && state.selected.asset === asset.key && state.selected.sma === sma && state.selected.buffer === buf;
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
      + '<h2>Strategy Explorer — ' + asset.label + ', ' + (gs.enabled ? 'vol-gated ' + gs.high + '×→' + gs.low + '× (' + (gs.latch ? 'latched' : 'unlatched') + ')' : 'binary in/out at ' + state.leverage + 'x') + '</h2>'
      + controlsHTML(costs)
      + legendHTML(maxAbs)
      + '<div class="matrixwrap"><table class="matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
      + '<div class="toolsrow">'
      + 'Each cell: <strong>CAGR</strong> on top, <strong>max drawdown</strong> below, net of the costs configured below. '
      + (asset.live ? 'Ringed cell is the live ' + asset.live.sma + 'd/' + asset.live.buffer + '% setting. ' : "")
      + (ruinedCount
        ? '<strong>' + ruinedCount + ' of ' + total + ' combos were wiped out at ' + state.leverage + 'x</strong> (costs included). '
        : 'No combo was wiped out at ' + state.leverage + 'x. ')
      + 'Backtested on ' + asset.backtestAsset + '. '
      + 'Each period is compounded fresh from its own start, so RUINED means wiped out <em>inside</em> the selected window; '
      + 'the in/out signal still carries in from before it, so there is no artificial trade on day one.'
      + '</div></div>';

    html += costsPanelHTML(costs, refRates, prices, period, gs);

    if (state.selected && state.selected.asset === asset.key) {
      var selWalk = walkFor(prices, asset.key, state.selected.sma, state.selected.buffer, gs);
      html += window.PriceChart.render(prices, state.selected, state.leverage, period, selWalk);
      html += costBreakdownHTML(prices, selWalk, period, state.leverage, ec);
      html += window.PerfChart.render(prices, state.selected, state.leverage, period, selWalk,
        state.perfMode, state.annMode, ec);
    }

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
      state.selected = null;
    });
    bind("[data-period]", function (el) { state.periodIdx = Number(el.getAttribute("data-period")); });
    bind("[data-lev]", function (el) { state.leverage = Number(el.getAttribute("data-lev")); });
    bind("[data-sizing]", function (el) { state.sizing = el.getAttribute("data-sizing"); });
    bind("[data-latch]", function (el) { state.latch = el.getAttribute("data-latch") === "1"; });
    bind("[data-vw]", function (el) { state.volLen = Number(el.getAttribute("data-vw")); });
    bind("[data-gate]", function (el) { state.gate[state.asset] = Number(el.getAttribute("data-gate")); });
    bind("[data-down]", function (el) { state.downTo = Number(el.getAttribute("data-down")); });
    bind("[data-grid]", function (el) { state.grid = el.getAttribute("data-grid"); });
    bind("[data-metric]", function (el) { state.metric = el.getAttribute("data-metric"); });
    bind("[data-slip]", function (el) { state.slippageTier = el.getAttribute("data-slip"); });
    bind("[data-perf]", function (el) { state.perfMode = el.getAttribute("data-perf"); });
    bind("[data-ann]", function (el) { state.annMode = el.getAttribute("data-ann"); });

    // Edits apply to the product held at the selected leverage.
    var costCfg = costConfigFor(costAssumptions, state.asset);
    var heldProduct = window.CostModel.pickProduct(costCfg.products, state.leverage);
    [["#cost-mgmt", "mgmtFeePct"], ["#cost-swap", "dailySwapRatePct"], ["#cost-spread", "fundingSpreadPct"], ["#cost-basis", "basisPct"]].forEach(function (pair) {
      var input = container.querySelector(pair[0]);
      if (!input || !heldProduct) return;
      input.addEventListener("change", function () {
        var perAsset = state.costOverrides[state.asset] = state.costOverrides[state.asset] || {};
        var perProduct = perAsset[heldProduct.leverage] = perAsset[heldProduct.leverage] || {};
        perProduct[pair[1]] = Math.max(0, parseFloat(input.value) || 0);
        rerender();
      });
    });

    container.querySelectorAll(".mcell").forEach(function (cell) {
      function toggle() {
        var sma = Number(cell.getAttribute("data-sma")), buf = Number(cell.getAttribute("data-buf"));
        var same = state.selected && state.selected.asset === state.asset && state.selected.sma === sma && state.selected.buffer === buf;
        state.selected = same ? null : { asset: state.asset, sma: sma, buffer: buf };
        rerender();
      }
      cell.addEventListener("click", toggle);
      cell.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
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
