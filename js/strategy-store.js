// The list of strategies shown on the Home and Developed tabs, and the only
// code that changes it.
//
// It lives in the Supabase `strategies` table (created by
// supabase/strategies.sql) so it is the same on every device. Each row's `def`
// is a strategies.json-shaped entry — exactly what StrategyEngine.walk reads —
// and `on_home` is what strategies.json called `active`. Until the table
// exists this falls back to strategies.json, read-only, and says so.
//
// A strategy built on the Strategy Explorer is a different shape (asset key,
// sizing mode, % parameters); fromConfig() is the one place that converts it.
window.StrategyStore = (function () {
  var SC = window.StrategyConfig;
  var sb = null;
  var mode = { readOnly: true, reason: null };

  function init(client) { sb = client; }

  // The table is writable with the public anon key, so a row is untrusted
  // input: its name is HTML-escaped once here (the cards build HTML from it;
  // `rawName` keeps the original for plain-text uses), and an id that isn't a
  // plain token is dropped rather than put into an attribute.
  function escapeHTML(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function rowToStrategy(r) {
    var s = Object.assign({}, r.def, { id: r.id, active: !!r.on_home });
    s.rawName = String(s.name || r.id);
    s.name = escapeHTML(s.rawName);
    return s;
  }

  // Returns the strategy list, ordered as stored.
  async function load() {
    var res = await sb.from("strategies").select("id,position,on_home,def,created_at")
      .order("position", { ascending: true }).order("created_at", { ascending: true });
    if (!res.error) {
      mode = { readOnly: false, reason: null };
      return res.data.filter(function (r) { return /^[\w-]+$/.test(r.id) && r.def && r.def.smaLen > 0; })
        .map(rowToStrategy);
    }
    // Table not created yet (Postgres 42P01 / PostgREST PGRST205) — fall back.
    var missing = res.error.code === "42P01" || res.error.code === "PGRST205" || /does not exist|could not find the table/i.test(res.error.message || "");
    if (!missing) throw new Error("strategies: " + res.error.message);
    mode = { readOnly: true, reason: "setup" };
    var f = await fetch("strategies.json");
    return await f.json();
  }

  function isReadOnly() { return mode.readOnly; }

  function setupNoteHTML() {
    if (mode.reason !== "setup") return "";
    return '<div class="toolsrow">Showing <code>strategies.json</code>, read-only. To add and remove strategies from the site, '
      + 'run <code>supabase/strategies.sql</code> once in Supabase &rarr; SQL Editor (it creates the table and copies these strategies into it).</div>';
  }

  // The backtest series a strategy is costed as: SPX_MERGED and SPY are both the S&P.
  function costKeyFor(strategy) {
    if (strategy.costAsset) return strategy.costAsset;
    if (strategy.backtestAsset === "SPX_MERGED" || strategy.backtestAsset === "SPY") return "SP500";
    var a = SC.ASSETS.filter(function (x) { return x.backtestAsset === strategy.backtestAsset; })[0];
    return a ? a.key : null;
  }

  // Explorer/Evaluator config -> strategies.json-shaped definition. Mirrors
  // StrategyConfig.paramsFor, so the Developed tab walks it exactly as the
  // Explorer did (252-day vol annualisation for every asset, as there).
  function fromConfig(cfg, name) {
    var p = cfg.params, a = SC.assetConfig(cfg.asset);
    var gated = SC.isGated(cfg) && p.high > 1 && p.low < p.high;
    return {
      name: name || (a.label + " — " + SC.describe(cfg, null)),
      liveAsset: cfg.asset === "SP500" ? "SPY" : a.backtestAsset,
      backtestAsset: a.backtestAsset,
      costAsset: cfg.asset,
      smaLen: p.sma,
      buffer: p.buffer / 100,
      volLen: gated ? p.volwin : null,
      volGate: gated ? p.gate / 100 : null,
      annualization: 252,
      leverage: { base: p.high, gated: gated ? p.low : null },
      latch: gated ? p.latch : undefined,
      outLeverage: p.out || 0,
      meterRange: cfg.asset === "BTC" ? { min: -6, max: 22 } : { min: -6, max: 14 },
      // Kept so the same strategy isn't added twice, and so it can be traced
      // back to the Explorer settings it came from.
      source: { asset: cfg.asset, sizing: cfg.sizing, params: Object.assign({}, p) }
    };
  }

  function sameSource(a, b) {
    return a && b && a.asset === b.asset && a.sizing === b.sizing
      && SC.PARAM_ORDER.every(function (k) { return a.params[k] === b.params[k]; });
  }

  async function addFromConfig(cfg, name, existing) {
    if (mode.readOnly) return { error: "Run supabase/strategies.sql in Supabase first — until then the strategy list is read-only." };
    var def = fromConfig(cfg, name);
    var dupe = (existing || []).filter(function (s) { return sameSource(s.source, def.source); })[0];
    if (dupe) return { error: "That strategy is already on the Developed tab as “" + (dupe.rawName || dupe.name) + "”." };
    var pos = (existing || []).length;
    var id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var res = await sb.from("strategies").insert({ id: id, position: pos, on_home: false, def: def });
    if (res.error) return { error: "Couldn't add: " + res.error.message };
    return { id: id, name: def.name };
  }

  async function setOnHome(id, on) {
    var res = await sb.from("strategies").update({ on_home: !!on }).eq("id", id);
    if (res.error) throw new Error(res.error.message);
  }

  async function remove(id) {
    var res = await sb.from("strategies").delete().eq("id", id);
    if (res.error) throw new Error(res.error.message);
  }

  return {
    init: init, load: load, isReadOnly: isReadOnly, setupNoteHTML: setupNoteHTML,
    costKeyFor: costKeyFor, fromConfig: fromConfig, addFromConfig: addFromConfig,
    setOnHome: setOnHome, remove: remove
  };
})();
