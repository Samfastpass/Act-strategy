// Bootstraps the app: creates the Supabase client, loads all price series
// once, wires up tab switching, and (re)renders each tab from shared data.
(function () {
  var statusEl = document.getElementById("status");
  var tabnav = document.getElementById("tabnav");
  var asofEl = document.getElementById("asof");
  var panels = {
    home: document.getElementById("tab-home"),
    developed: document.getElementById("tab-developed"),
    explorer: document.getElementById("tab-explorer")
  };

  window.addEventListener("error", function (e) {
    if (statusEl && statusEl.className === "loading") {
      statusEl.className = "fatal";
      statusEl.innerHTML = "Something broke before the page could load: " + e.message;
    }
  });

  var sb = null;
  try {
    sb = window.App.getClient();
  } catch (e) {
    statusEl.className = "fatal";
    statusEl.innerHTML = "Couldn't set up the Supabase client: " + e.message + ". This usually means the supabase-js library didn't load — check your internet connection and reload.";
    return;
  }

  function mapRow(r) { return { date: r.date, close: Number(r.close) }; }

  // The Supabase project caps every response at 1000 rows server-side
  // (db.max_rows) regardless of the range requested, so a single
  // unpaginated query silently truncates any series longer than that
  // (BTC alone has 5800+ days). Page through with .range() until a page
  // comes back short.
  var PAGE_SIZE = 1000;
  async function loadAsset(asset) {
    var rows = [];
    for (var offset = 0; ; offset += PAGE_SIZE) {
      var res = await sb.from("prices").select("date,close").eq("asset", asset)
        .order("date", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
      if (res.error) throw new Error(asset + ": " + res.error.message);
      rows = rows.concat(res.data.map(mapRow));
      if (res.data.length < PAGE_SIZE) break;
    }
    return rows;
  }

  async function loadAllData() {
    var assets = ["BTC", "SPX", "SPY", "SPX_MERGED"];
    var results = await Promise.all(assets.map(loadAsset));
    return { btc: results[0], spx: results[1], spy: results[2], spxMerged: results[3] };
  }

  var state = { data: null, strategies: null };

  var ctx = {
    sb: sb,
    getData: function () { return state.data; },
    onImported: async function () {
      state.data = await loadAllData();
      renderAll();
    }
  };

  function renderAll() {
    if (asofEl && state.data.btc.length) {
      asofEl.textContent = "as of " + state.data.btc[state.data.btc.length - 1].date + " close";
    }
    window.Home.render(panels.home, state.data, state.strategies, ctx);
    window.Developed.render(panels.developed, state.data, state.strategies, ctx);
    window.Explorer.render(panels.explorer);
  }

  function switchTab(name) {
    Object.keys(panels).forEach(function (key) {
      panels[key].style.display = key === name ? "" : "none";
    });
    tabnav.querySelectorAll(".tab").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === name);
    });
  }

  tabnav.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () { switchTab(btn.getAttribute("data-tab")); });
  });

  async function init() {
    try {
      var stratRes = await fetch("strategies.json");
      state.strategies = await stratRes.json();

      state.data = await loadAllData();
      if (state.data.btc.length === 0 || state.data.spy.length === 0) {
        statusEl.className = "fatal";
        statusEl.innerHTML = "Connected, but the prices table looks empty for BTC or SPY — check the CSV import landed.";
        return;
      }

      statusEl.style.display = "none";
      tabnav.style.display = "";
      switchTab("home");
      renderAll();
    } catch (e) {
      statusEl.className = "fatal";
      statusEl.innerHTML = "Couldn't load the app: " + e.message
        + (location.protocol === "file:" ? " (strategies.json can't be fetched when opening this file directly — serve the folder with a local static server instead.)" : "");
    }
  }

  init();
})();
