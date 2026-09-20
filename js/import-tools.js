// Data import tooling, mounted on the Developed Strategies tab (both panels)
// and the Strategy Explorer tab (the Twelve Data refresh only):
//   1. A "Refresh from Twelve Data" button that pulls missing recent days
//      for BTC/SPY from the Twelve Data API.
//   2. A CSV drag-and-drop for bulk/backfill imports.
// Both funnel through importRows(), which upserts into Supabase `prices`
// and then keeps SPX_MERGED in sync via MergeSeries.
//
// The Twelve Data API key is NOT stored in any committed file. It's typed
// into a field here and kept only in this browser's localStorage — it's a
// metered, personal-account key (unlike the Supabase anon key), so it must
// never end up in the public repo.
window.ImportTools = (function () {
  var fmt = window.App.fmt;
  var LS_KEY = "strategy_tracker_twelvedata_key";
  // backfillFrom only matters for an asset with no existing rows yet (the
  // three new explorer assets) — it's where a first-ever fetch starts from.
  // Existing assets (BTC/SPY) always have rows already, so they ignore it
  // and refresh from their last stored date instead.
  var TWELVEDATA_SYMBOLS = {
    BTC: { symbol: "BTC/USD" },
    SPY: { symbol: "SPY" },
    GOLD: { symbol: "XAU/USD", backfillFrom: "1990-01-01" },
    // QQQ and S100 are real, liquid ETF proxies confirmed against Twelve
    // Data's symbol_search (see PROJECT_NOTES.md) — not the raw multi-decade
    // index. History only goes back to each ETF's own inception, materially
    // shorter than SPX_MERGED's 1928+.
    NASDAQ100: { symbol: "QQQ", exchange: "NASDAQ", backfillFrom: "1999-01-01" },
    FTSE100: { symbol: "S100", mic: "XLON", backfillFrom: "2011-01-01" }
  };

  function getSavedApiKey() {
    try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; }
  }
  function saveApiKey(key) {
    try {
      if (key) localStorage.setItem(LS_KEY, key);
      else localStorage.removeItem(LS_KEY);
    } catch (e) { /* localStorage unavailable — key just won't persist */ }
  }

  function addDaysUTC(dateStr, n) {
    var d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function todayUTC() { return new Date().toISOString().slice(0, 10); }

  async function fetchTwelveData(symbolCfg, startDate, endDate, apiKey) {
    var url = "https://api.twelvedata.com/time_series"
      + "?symbol=" + encodeURIComponent(symbolCfg.symbol)
      + "&interval=1day&order=ASC&format=JSON"
      + "&start_date=" + startDate + "&end_date=" + endDate
      + "&apikey=" + encodeURIComponent(apiKey);
    if (symbolCfg.exchange) url += "&exchange=" + encodeURIComponent(symbolCfg.exchange);
    if (symbolCfg.mic) url += "&mic_code=" + encodeURIComponent(symbolCfg.mic);
    var res = await fetch(url);
    var json = await res.json();
    if (json.status === "error") throw new Error(json.message || "Twelve Data error");
    if (!json.values) return [];
    return json.values.map(function (v) { return { date: v.datetime.slice(0, 10), close: parseFloat(v.close) }; });
  }

  // Twelve Data's free tier caps a single request at ~5000 points (~19 years
  // of daily data). A brand-new asset's first-ever fetch can span decades, so
  // chunk it — 12-year windows stay safely under the cap for any daily-
  // frequency asset, including one (like BTC) with no weekend gaps.
  async function fetchTwelveDataRange(symbolCfg, startDate, endDate, apiKey) {
    var CHUNK_YEARS = 12;
    var rows = [];
    var chunkStart = startDate;
    while (chunkStart <= endDate) {
      var d = new Date(chunkStart + "T00:00:00Z");
      d.setUTCFullYear(d.getUTCFullYear() + CHUNK_YEARS);
      var chunkEnd = d.toISOString().slice(0, 10);
      if (chunkEnd > endDate) chunkEnd = endDate;
      var chunkRows = await fetchTwelveData(symbolCfg, chunkStart, chunkEnd, apiKey);
      rows = rows.concat(chunkRows);
      if (chunkEnd >= endDate) break;
      chunkStart = addDaysUTC(chunkEnd, 1);
    }
    return rows;
  }

  function parseCsv(text) {
    var lines = text.split(/\r\n|\n/).filter(function (l) { return l.trim().length > 0; });
    if (!lines.length) return [];
    var header = lines[0].split(",").map(function (h) { return h.trim().toLowerCase(); });
    var dateIdx = header.indexOf("date");
    if (dateIdx < 0) dateIdx = header.indexOf("datetime");
    var closeIdx = header.indexOf("close");
    if (dateIdx < 0 || closeIdx < 0) {
      throw new Error("CSV needs a date/datetime column and a close column (found: " + header.join(", ") + ").");
    }
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = lines[i].split(",");
      var dateVal = (cols[dateIdx] || "").trim();
      var closeVal = parseFloat(cols[closeIdx]);
      if (!dateVal || isNaN(closeVal)) continue;
      rows.push({ date: dateVal.slice(0, 10), close: closeVal });
    }
    return rows;
  }

  async function importRows(ctx, asset, rows) {
    if (!rows.length) return;
    var payload = rows.map(function (r) { return { asset: asset, date: r.date, close: r.close }; });
    var res = await ctx.sb.from("prices").upsert(payload, { onConflict: "asset,date" });
    if (res.error) throw new Error(asset + ": " + res.error.message);

    var data = ctx.getData();
    var mergedRows = window.MergeSeries.deriveMergedRows(asset, rows, data.spx, data.spy);
    if (mergedRows.length) {
      var res2 = await ctx.sb.from("prices").upsert(mergedRows, { onConflict: "asset,date" });
      if (res2.error) throw new Error("SPX_MERGED sync: " + res2.error.message);
    }
  }

  function refreshPanelHTML() {
    return ''
      + '<div class="panel">'
      + '<h2>Refresh from Twelve Data</h2>'
      + '<div class="formrow" style="grid-template-columns: 2fr auto auto;">'
      + '<div class="field"><label>API key (kept only in this browser)</label><input type="password" id="td-api-key" placeholder="paste your Twelve Data API key"></div>'
      + '<button class="add" id="td-clear-key" style="background:var(--card); color:var(--ink); border-color:var(--line);">Clear key</button>'
      + '<button class="add" id="td-refresh-btn">Refresh</button>'
      + '</div>'
      + '<div id="td-status" class="errtext" style="display:none;"></div>'
      + '<div id="td-preview" style="display:none; margin-top:10px;">'
      + '<div id="td-preview-body" style="font-size:12px; color:var(--ink-soft);"></div>'
      + '<button class="add" id="td-confirm-btn" style="margin-top:8px;">Confirm import</button>'
      + '</div>'
      + '</div>';
  }

  function csvPanelHTML() {
    return ''
      + '<div class="panel">'
      + '<h2>Drop a CSV to import</h2>'
      + '<div class="formrow" style="grid-template-columns: 1fr auto;">'
      + '<div class="field"><label>Asset</label><select id="csv-asset-select">'
      + '<option value="BTC">BTC</option><option value="SPX">SPX</option><option value="SPY">SPY</option>'
      + '<option value="GOLD">GOLD</option><option value="NASDAQ100">NASDAQ100</option><option value="FTSE100">FTSE100</option>'
      + '</select></div>'
      + '<div></div>'
      + '</div>'
      + '<div class="dropzone" id="csv-dropzone" tabindex="0">Drop a CSV here, or click to choose a file<br><span style="font-size:11px;">expects a date/datetime column and a close column</span></div>'
      + '<input type="file" id="csv-file-input" accept=".csv" style="display:none;">'
      + '<div id="csv-status" class="errtext" style="display:none;"></div>'
      + '<div id="csv-preview" style="display:none; margin-top:10px;">'
      + '<div id="csv-preview-body" style="font-size:12px; color:var(--ink-soft);"></div>'
      + '<button class="add" id="csv-confirm-btn" style="margin-top:8px;">Confirm import</button>'
      + '</div>'
      + '</div>';
  }

  function panelHTML() { return refreshPanelHTML() + csvPanelHTML(); }

  // Wires whichever of the two panels is present in `container` — the
  // Strategy Explorer mounts only the Twelve Data refresh, the Developed tab
  // mounts both.
  function wireUp(container, ctx) {
    if (container.querySelector("#td-api-key")) wireRefresh(container, ctx);
    if (container.querySelector("#csv-dropzone")) wireCsv(container, ctx);
  }

  function wireRefresh(container, ctx) {
    var apiKeyInput = container.querySelector("#td-api-key");
    var clearKeyBtn = container.querySelector("#td-clear-key");
    var refreshBtn = container.querySelector("#td-refresh-btn");
    var tdStatus = container.querySelector("#td-status");
    var tdPreview = container.querySelector("#td-preview");
    var tdPreviewBody = container.querySelector("#td-preview-body");
    var tdConfirmBtn = container.querySelector("#td-confirm-btn");

    apiKeyInput.value = getSavedApiKey();
    apiKeyInput.addEventListener("change", function () { saveApiKey(apiKeyInput.value.trim()); });
    clearKeyBtn.addEventListener("click", function () { apiKeyInput.value = ""; saveApiKey(""); });

    function showStatus(el, msg, isError) {
      el.style.display = "block";
      el.textContent = msg;
      el.style.color = isError ? "var(--warn)" : "var(--ink-soft)";
    }
    function hideStatus(el) { el.style.display = "none"; }

    var pendingTd = null; // { BTC: rows, SPY: rows }

    refreshBtn.addEventListener("click", async function () {
      var apiKey = apiKeyInput.value.trim();
      if (!apiKey) { showStatus(tdStatus, "Add your Twelve Data API key first.", true); return; }
      hideStatus(tdStatus);
      tdPreview.style.display = "none";
      refreshBtn.disabled = true; refreshBtn.textContent = "Fetching…";
      try {
        var data = ctx.getData();
        var end = todayUTC();
        var results = {};
        var lines = [];
        for (var asset in TWELVEDATA_SYMBOLS) {
          var cfg = TWELVEDATA_SYMBOLS[asset];
          var existing = data[window.App.assetKey(asset)] || [];
          var lastRow = existing.slice(-1)[0];
          // A brand-new asset with no rows yet starts from its configured
          // backfill date and pulls full history; an asset that already has
          // data just tops up from where it left off, same as before.
          var start = lastRow ? addDaysUTC(lastRow.date, 1) : cfg.backfillFrom;
          if (!start || start > end) { lines.push(asset + ": already up to date"); continue; }
          var isBackfill = !lastRow;
          var rows = await fetchTwelveDataRange(cfg, start, end, apiKey);
          results[asset] = rows;
          lines.push(asset + (isBackfill ? " (full history)" : "") + ": " + rows.length + " new day(s)"
            + (rows.length ? " (" + rows[0].date + " to " + rows[rows.length - 1].date + ")" : ""));
        }
        pendingTd = results;
        tdPreviewBody.innerHTML = lines.join("<br>");
        tdPreview.style.display = "block";
      } catch (e) {
        showStatus(tdStatus, "Couldn't fetch: " + e.message, true);
      } finally {
        refreshBtn.disabled = false; refreshBtn.textContent = "Refresh";
      }
    });

    tdConfirmBtn.addEventListener("click", async function () {
      if (!pendingTd) return;
      tdConfirmBtn.disabled = true; tdConfirmBtn.textContent = "Saving…";
      try {
        for (var asset in pendingTd) {
          await importRows(ctx, asset, pendingTd[asset]);
        }
        pendingTd = null;
        tdPreview.style.display = "none";
        await ctx.onImported();
      } catch (e) {
        showStatus(tdStatus, "Couldn't save: " + e.message, true);
      } finally {
        tdConfirmBtn.disabled = false; tdConfirmBtn.textContent = "Confirm import";
      }
    });

  }

  function wireCsv(container, ctx) {
    function showStatus(el, msg, isError) {
      el.style.display = "block";
      el.textContent = msg;
      el.style.color = isError ? "var(--warn)" : "var(--ink-soft)";
    }
    function hideStatus(el) { el.style.display = "none"; }

    var assetSelect = container.querySelector("#csv-asset-select");
    var dropzone = container.querySelector("#csv-dropzone");
    var fileInput = container.querySelector("#csv-file-input");
    var csvStatus = container.querySelector("#csv-status");
    var csvPreview = container.querySelector("#csv-preview");
    var csvPreviewBody = container.querySelector("#csv-preview-body");
    var csvConfirmBtn = container.querySelector("#csv-confirm-btn");
    var pendingCsv = null; // { asset, rows }

    function handleFile(file) {
      hideStatus(csvStatus);
      csvPreview.style.display = "none";
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var rows = parseCsv(String(reader.result));
          if (!rows.length) throw new Error("No usable rows found.");
          pendingCsv = { asset: assetSelect.value, rows: rows };
          csvPreviewBody.textContent = assetSelect.value + ": " + rows.length + " row(s), " + rows[0].date + " to " + rows[rows.length - 1].date;
          csvPreview.style.display = "block";
        } catch (e) {
          showStatus(csvStatus, e.message, true);
        }
      };
      reader.onerror = function () { showStatus(csvStatus, "Couldn't read that file.", true); };
      reader.readAsText(file);
    }

    dropzone.addEventListener("click", function () { fileInput.click(); });
    dropzone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
    fileInput.addEventListener("change", function () { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
    dropzone.addEventListener("dragover", function (e) { e.preventDefault(); dropzone.style.borderColor = "var(--ink)"; });
    dropzone.addEventListener("dragleave", function () { dropzone.style.borderColor = ""; });
    dropzone.addEventListener("drop", function (e) {
      e.preventDefault();
      dropzone.style.borderColor = "";
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    csvConfirmBtn.addEventListener("click", async function () {
      if (!pendingCsv) return;
      csvConfirmBtn.disabled = true; csvConfirmBtn.textContent = "Saving…";
      try {
        await importRows(ctx, pendingCsv.asset, pendingCsv.rows);
        pendingCsv = null;
        csvPreview.style.display = "none";
        await ctx.onImported();
      } catch (e) {
        showStatus(csvStatus, "Couldn't save: " + e.message, true);
      } finally {
        csvConfirmBtn.disabled = false; csvConfirmBtn.textContent = "Confirm import";
      }
    });
  }

  return { panelHTML: panelHTML, refreshPanelHTML: refreshPanelHTML, csvPanelHTML: csvPanelHTML, wireUp: wireUp };
})();
