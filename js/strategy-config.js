// What a strategy IS, and how to score one — shared by the Strategy Explorer
// and the Evaluator.
//
// This exists because two tabs now need the same pipeline: take a parameter set
// (SMA, buffer, start leverage, drop-to, below-SMA tier, vol window, gate,
// latch), decide whether it can run at all, walk it, and compound it over a
// window net of costs. That used to live inside js/explorer.js; a second copy
// in the Evaluator is exactly the duplication that let the leverage bug ship in
// one place and not another (PROJECT_NOTES.md). One copy, here.
//
// It owns the session settings both tabs must agree on — the slippage tier and
// any cost-field edits — so a fee typed on the Explorer changes the Evaluator's
// numbers too, and the saved-configuration list (localStorage, this browser
// only). It does NOT own any UI.
window.StrategyConfig = (function () {

  // gate: the vol-gate thresholds offered (annualised vol, %) and the default.
  // S&P's 22% is the live strategy's; the others are round numbers around each
  // asset's typical vol, NOT tuned — no live strategy exists. BTC has no
  // leveraged product, so there is nothing to gate.
  var ASSETS = [
    { key: "SP500", label: "S&P 500", backtestAsset: "SPX_MERGED",
      live: { sizing: "gated", params: { sma: 200, buffer: 3, high: 5, low: 3, out: 0, volwin: 20, gate: 22, latch: true } },
      gate: { options: [16, 18, 20, 22, 25, 30], def: 22 } },
    { key: "BTC", label: "Bitcoin", backtestAsset: "BTC", live: null, gate: null },
    { key: "GOLD", label: "Gold", backtestAsset: "GOLD", live: null, gate: { options: [10, 12, 15, 18, 22], def: 15 } },
    { key: "NASDAQ100", label: "Nasdaq 100", backtestAsset: "NASDAQ100", live: null, gate: { options: [18, 22, 26, 30, 35], def: 26 } },
    { key: "FTSE100", label: "FTSE 100", backtestAsset: "FTSE100", live: null, gate: { options: [12, 14, 16, 18, 22], def: 16 } }
  ];

  var PARAMS = {
    sma:    { label: "SMA length",     short: "SMA",       gated: false, fmt: function (v) { return v + "d"; }, num: { min: 5, max: 400, step: 5 } },
    buffer: { label: "Buffer",         short: "Buffer",    gated: false, fmt: function (v) { return v + "%"; }, num: { min: 0, max: 20, step: 0.5 } },
    high:   { label: "Start leverage", short: "Start lev", gated: false, fmt: function (v) { return v + "×"; } },
    low:    { label: "Drop down to",   short: "Drop to",   gated: true,  fmt: function (v) { return v + "×"; } },
    // What is held while the strategy is OUT (below the SMA). 0 = cash, the original behaviour.
    out:    { label: "Below the SMA",  short: "Below SMA", gated: false, fmt: function (v) { return v === 0 ? "cash" : v + "×"; } },
    volwin: { label: "Vol window",     short: "Vol win",   gated: true,  fmt: function (v) { return v + "d"; }, num: { min: 2, max: 250, step: 5 } },
    gate:   { label: "Vol gate",       short: "Gate",      gated: true,  fmt: function (v) { return v + "%"; }, num: { min: 1, max: 150, step: 1 } },
    latch:  { label: "Latch",          short: "Latch",     gated: true,  fmt: function (v) { return v ? "latched" : "unlatched"; } }
  };
  var PARAM_ORDER = ["sma", "buffer", "high", "low", "out", "volwin", "gate", "latch"];
  var ALL_LEVERAGES = [1, 2, 3, 5];
  var OUT_LEVERAGES = [0, 1, 2, 3];
  var VOL_WINDOWS = [10, 20, 30, 60];

  // Settings both tabs share, so their numbers can never disagree.
  var session = {
    slippageTier: "medium",
    costOverrides: {} // assetKey -> { productLeverage -> { mgmtFeePct, ... } }
  };

  var walkCache = {};   // stamp|sma|buffer|gating -> walk
  var volCache = {};    // stamp|volLen -> realised-vol series
  var statsCache = {};  // stamp|period|costs|strategy -> window stats

  function assetConfig(key) { return ASSETS.filter(function (a) { return a.key === key; })[0]; }

  // --- what a strategy can and cannot be -----------------------------------
  // `cfg` throughout is { asset: key, sizing: "fixed"|"gated", params: {...} }.
  function isGated(cfg) {
    var a = assetConfig(cfg.asset);
    return cfg.sizing === "gated" && !!(a && a.gate);
  }

  // The lowest exposure held while IN (drop-to if vol-gated, else the single leverage).
  function minAbove(cfg) {
    return isGated(cfg) && cfg.params.high > 1 ? cfg.params.low : cfg.params.high;
  }

  // Turns a full parameter set into what the walk needs — or says why it can't run.
  function resolve(cfg, costs) {
    var p = cfg.params;
    if (p.high > costs.maxLeverage) return { invalid: "no real product at " + p.high + "×" };
    if (p.out >= minAbove(cfg)) return { invalid: "the leverage held below the SMA (" + PARAMS.out.fmt(p.out) + ") must be lower than the lowest leverage held above it (" + minAbove(cfg) + "×)" };
    if (!isGated(cfg)) return { gs: { enabled: false } };
    if (p.high <= 1) return { invalid: "vol gating needs a start leverage above 1×" };
    if (p.low >= p.high) return { invalid: "drop-to (" + p.low + "×) must be below the start leverage (" + p.high + "×)" };
    return { gs: { enabled: true, volLen: p.volwin, gatePct: p.gate, gate: p.gate / 100, high: p.high, low: p.low, latch: p.latch } };
  }

  // Clamps a parameter set to what the asset and sizing mode allow. Mutates.
  function normalize(cfg, costs) {
    var p = cfg.params, a = assetConfig(cfg.asset);
    if (p.high > costs.maxLeverage) p.high = costs.maxLeverage;
    if (a && !a.gate && cfg.sizing === "gated") cfg.sizing = "fixed";
    if (cfg.sizing === "gated" && p.high > 1) {
      var lows = ALL_LEVERAGES.filter(function (l) { return l < p.high; });
      if (lows.indexOf(p.low) < 0) p.low = lows[lows.length - 1];
    }
    // What you hold below the SMA must sit below the lowest leverage you hold
    // above it — otherwise it is not a defensive tier.
    var ceiling = minAbove(cfg);
    if (p.out >= ceiling) {
      var outs = OUT_LEVERAGES.filter(function (l) { return l < ceiling; });
      p.out = outs[outs.length - 1];
    }
  }

  // `gs` is optional: without one, the gating is derived from the config, so a
  // caller that has no cost config (the Evaluator's saved-strategy list) still
  // describes a gated strategy as gated rather than as plain leverage.
  function describe(cfg, gs) {
    var p = cfg.params;
    if (!gs && isGated(cfg) && p.high > 1 && p.low < p.high) {
      gs = { enabled: true, volLen: p.volwin, gatePct: p.gate, high: p.high, low: p.low, latch: p.latch };
    }
    var base = p.sma + "d SMA / " + p.buffer + "% buffer";
    var below = p.out > 0 ? " · " + p.out + "× below the SMA" : "";
    if (gs && gs.enabled) return base + " · " + gs.high + "×→" + gs.low + "× " + (gs.latch ? "latched" : "unlatched") + " · " + gs.volLen + "d vol ≥ " + gs.gatePct + "%" + below;
    return base + " · " + p.high + "×" + (p.out > 0 ? below : " in/out");
  }

  function gateLabel(gs) {
    return gs.high + "×→" + gs.low + "× " + (gs.latch ? "latched" : "unlatched") + " at " + gs.volLen + "d vol ≥ " + gs.gatePct + "%";
  }

  // --- walking --------------------------------------------------------------
  function paramsFor(smaLen, bufferPct, gs, volSeries) {
    if (gs && gs.enabled) {
      return {
        smaLen: smaLen, buffer: bufferPct / 100,
        volLen: gs.volLen, volGate: gs.gate, annualization: 252, volSeries: volSeries,
        // The walk is done AT the real leverages: when the gate trips the state
        // changes between two non-zero levels, so the walk (not the caller)
        // decides the exposure.
        leverage: { base: gs.high, gated: gs.low }, latch: gs.latch,
        sizing: { mode: "fixedLeverage" }
      };
    }
    return {
      smaLen: smaLen, buffer: bufferPct / 100,
      volLen: null, volGate: null, annualization: 252,
      // Walk at 1x: for a binary strategy the *timing* of in/out doesn't depend
      // on leverage at all, so one walk serves every leverage setting.
      leverage: { base: 1, gated: null },
      sizing: { mode: "fixedLeverage" }
    };
  }

  // Caches are keyed on the price series' length and last date, so importing new
  // days invalidates them instead of serving walks that are one row short.
  // `tier` = { out, high }: what is held while OUT, and (for a fixed-leverage
  // walk) the leverage while IN. Neither changes the walk itself, so the cached
  // walk is shared and `out` is layered on a shallow copy.
  function walkFor(prices, assetKey, smaLen, bufferPct, gs, tier) {
    var base = walkBase(prices, assetKey, smaLen, bufferPct, gs);
    var out = (tier && tier.out) || 0;
    if (!out) return base;
    var copy = Object.assign({}, base, { out: out });
    copy.label = (base.gated ? base.label : tier.high + "× above the SMA") + ", " + out + "× below";
    return copy;
  }

  function walkBase(prices, assetKey, smaLen, bufferPct, gs) {
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

  // --- costs ----------------------------------------------------------------
  // cost-assumptions.json lists, per asset, the real products held at each
  // leverage. Here we (1) overlay any edits typed this session, and (2) turn
  // that into the plain object StrategyEngine.compoundEquity wants. The
  // fee/financing maths itself is in js/cost-model.js.
  var EDITABLE = ["mgmtFeePct", "dailySwapRatePct", "fundingSpreadPct", "basisPct"];

  function productWithEdits(assetKey, p) {
    var ov = (session.costOverrides[assetKey] || {})[p.leverage] || {};
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
      slippageBpsRoundTrip: (base.slippageBpsRoundTrip || { low: 0, medium: 0, high: 0 })[session.slippageTier] || 0,
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

  // --- scoring --------------------------------------------------------------
  // Compounds the window fresh from 1.0 at its start (capital restarts per
  // period; the in/out *state* still carries in from before, so there's no
  // artificial entry on day one). Delegates the actual compounding — leverage,
  // costs, ruin — to StrategyEngine.compoundEquity, the same core used
  // everywhere else equity gets computed in this app.
  function windowStats(prices, wk, period, leverage, costs) {
    var b = periodBounds(prices, period);
    var lo = Math.max(b.lo, wk.startIdx), hi = b.hi;
    if (hi - lo < 2) return { insufficient: true };

    var exposure = new Array(hi + 1);
    var trades = 0;
    for (var i = lo; i <= hi; i++) {
      exposure[i] = window.StrategyEngine.exposureAt(wk, i, leverage);
      // A trade is a flip of the trend signal (in <-> out), so a strategy that
      // holds 1x below the SMA still counts its round trips.
      if (i > lo && (wk.state[i] > 0) !== (wk.state[i - 1] > 0)) trades++;
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

  // A period's identity for cache keys. It must come from the window's actual
  // bounds, never from an index into some tab's own period list — the Explorer's
  // period 0 is "All" and the Evaluator's is "2020s", and keying on the index
  // silently served one tab's numbers to the other.
  function periodSig(period) { return (period.from || "start") + ".." + (period.to || "end"); }

  // Resolve + walk + score, cached. `env` carries what is constant across a
  // render: { prices, stamp, costSig, costs, ec, period }.
  function evaluate(env, cfg) {
    var r = resolve(cfg, env.costs);
    if (r.invalid) return { invalid: r.invalid };
    var p = cfg.params;
    var key = env.stamp + "|" + periodSig(env.period) + "|" + env.costSig + "|"
      + (r.gs.enabled ? ["g", p.sma, p.buffer, p.volwin, p.gate, p.high, p.low, p.latch, p.out].join(":")
                      : ["f", p.sma, p.buffer, p.high, p.out].join(":"));
    if (statsCache[key]) return statsCache[key];
    if (Object.keys(statsCache).length > 4000) statsCache = {};
    var wk = walkFor(env.prices, cfg.asset, p.sma, p.buffer, r.gs, { out: p.out, high: p.high });
    statsCache[key] = windowStats(env.prices, wk, env.period, p.high, env.ec);
    return statsCache[key];
  }

  // Buy & hold at 1x over the same window, net of the 1x product's fee — the
  // benchmark a strategy has to beat to be worth running.
  function benchmark(env) {
    var key = env.stamp + "|" + periodSig(env.period) + "|" + env.costSig + "|bh";
    if (statsCache[key]) return statsCache[key];
    var b = periodBounds(env.prices, env.period);
    if (b.hi - b.lo < 2) return { insufficient: true };
    var wk = { state: [], sma: [], startIdx: b.lo, gated: false, out: 1 };
    for (var i = 0; i <= b.hi; i++) wk.state[i] = 0;   // always "out", held at 1x
    statsCache[key] = windowStats(env.prices, wk, env.period, 1, env.ec);
    return statsCache[key];
  }

  // --- saved configurations (this browser only) ------------------------------
  var LS_KEY = "strategy_tracker_saved_configs_v1";
  var MAX_SAVED = 8;

  function saved() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }   // private window, blocked storage, or corrupt JSON
  }

  function writeSaved(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }

  function save(cfg, name) {
    var list = saved();
    if (list.length >= MAX_SAVED) return { error: "You already have " + MAX_SAVED + " saved configurations — remove one first." };
    var entry = {
      id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || "", asset: cfg.asset, sizing: cfg.sizing,
      params: Object.assign({}, cfg.params)
    };
    // Saving the same thing twice is almost always a mis-click.
    var dupe = list.filter(function (e) {
      return e.asset === entry.asset && e.sizing === entry.sizing
        && PARAM_ORDER.every(function (k) { return e.params[k] === entry.params[k]; });
    })[0];
    if (dupe) return { error: "That exact configuration is already saved as “" + (dupe.name || describe(dupe, null)) + "”.", existing: dupe.id };
    list.push(entry);
    if (!writeSaved(list)) return { error: "Couldn't save — this browser is blocking local storage." };
    return { entry: entry };
  }

  function remove(id) { writeSaved(saved().filter(function (e) { return e.id !== id; })); }

  function rename(id, name) {
    var list = saved();
    list.forEach(function (e) { if (e.id === id) e.name = name; });
    writeSaved(list);
  }

  function reorder(id, delta) {
    var list = saved();
    var i = list.findIndex(function (e) { return e.id === id; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    var t = list[i]; list[i] = list[j]; list[j] = t;
    writeSaved(list);
  }

  return {
    ASSETS: ASSETS, PARAMS: PARAMS, PARAM_ORDER: PARAM_ORDER,
    ALL_LEVERAGES: ALL_LEVERAGES, OUT_LEVERAGES: OUT_LEVERAGES, VOL_WINDOWS: VOL_WINDOWS,
    MAX_SAVED: MAX_SAVED, session: session,
    assetConfig: assetConfig, isGated: isGated, minAbove: minAbove, resolve: resolve,
    normalize: normalize, describe: describe, gateLabel: gateLabel,
    walkFor: walkFor, periodBounds: periodBounds, windowStats: windowStats,
    evaluate: evaluate, benchmark: benchmark,
    costConfigFor: costConfigFor, refSeriesFn: refSeriesFn, engineCostsFrom: engineCostsFrom, costVariant: costVariant,
    saved: saved, save: save, remove: remove, rename: rename, reorder: reorder
  };
})();
