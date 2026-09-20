// Shared Supabase client + small formatting/lookup helpers used across tabs.
window.App = window.App || {};

(function () {
  // ---- fill these in from Supabase → Settings → API ----
  var SUPABASE_URL = "https://jvtrzgjehyonyswcznaa.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_Zrzj8DAHnw6PlOzZfVHYaw_NaRUHvQZ";
  // This is the public anon key — meant to be exposed client-side, not a
  // secret. See PROJECT_NOTES.md. Do NOT put the Twelve Data API key here;
  // that one is entered at runtime and kept in localStorage (js/import-tools.js).
  // --------------------------------------------------------

  window.App.SUPABASE_URL = SUPABASE_URL;

  window.App.getClient = function () {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  };

  window.App.fmt = function (n, d) {
    d = d === undefined ? 0 : d;
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  // Maps the asset names used in strategies.json / Supabase ("BTC", "SPX",
  // "SPY", "SPX_MERGED") to the camelCase keys used on the in-memory data object.
  var ASSET_KEYS = {
    BTC: "btc", SPX: "spx", SPY: "spy", SPX_MERGED: "spxMerged",
    GOLD: "gold", NASDAQ100: "nasdaq100", FTSE100: "ftse100"
  };
  window.App.assetKey = function (assetName) { return ASSET_KEYS[assetName]; };
})();
