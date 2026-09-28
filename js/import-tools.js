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
  // everyDay: trades every calendar day, so any 2+-day gap is missing data
  // (the history check's gap scan); others allow weekends plus holidays.
  var TWELVEDATA_SYMBOLS = {
    BTC: { symbol: "BTC/USD", everyDay: true },
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
  function dayDiff(a, b) {
    return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
  }
  function todayUTC() { return new Date().toISOString().slice(0, 10); }

  // The free (Basic) plan allows 8 API credits per rolling minute and 800 per
  // day, and /time_series costs 1 credit per symbol per call — a multi-symbol
  // "batch" call still costs one credit per symbol, so batching saves nothing.
  // What does help: fewer calls (see fetchTwelveDataRange) and pacing them so
  // a refresh that needs more than 8 waits instead of failing on the 9th.
  var CREDITS_PER_MINUTE = 8;
  var MAX_POINTS = 5000;
  var callTimes = [];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function waitForCredit(onWait) {
    for (;;) {
      var now = Date.now();
      callTimes = callTimes.filter(function (t) { return now - t < 60000; });
      if (callTimes.length < CREDITS_PER_MINUTE) { callTimes.push(now); return; }
      var waitMs = 60000 - (now - callTimes[0]) + 500;
      if (onWait) onWait(Math.ceil(waitMs / 1000));
      await sleep(Math.min(waitMs, 1000));
    }
  }

  // One paced Twelve Data call. Throws on an API error, with its `code`.
  async function tdGet(endpoint, symbolCfg, query, apiKey, onWait) {
    var url = "https://api.twelvedata.com/" + endpoint
      + "?symbol=" + encodeURIComponent(symbolCfg.symbol) + "&interval=1day" + query
      + "&apikey=" + encodeURIComponent(apiKey);
    if (symbolCfg.exchange) url += "&exchange=" + encodeURIComponent(symbolCfg.exchange);
    if (symbolCfg.mic) url += "&mic_code=" + encodeURIComponent(symbolCfg.mic);
    for (var attempt = 0; ; attempt++) {
      await waitForCredit(onWait);
      var res = await fetch(url);
      var json = await res.json();
      if (json.status !== "error") return json;
      // Credits used elsewhere (another tab, another app on the same key)
      // aren't in callTimes — on a per-minute 429, wait out the minute once.
      if (json.code === 429 && attempt === 0 && /minute/i.test(json.message || "")) {
        callTimes = [];
        for (var s = 61; s > 0; s--) { if (onWait) onWait(s); await sleep(1000); }
        continue;
      }
      var err = new Error(json.message || "Twelve Data error");
      err.code = json.code;
      throw err;
    }
  }

  async function fetchTwelveData(symbolCfg, startDate, endDate, apiKey, onWait) {
    var json;
    try {
      json = await tdGet("time_series", symbolCfg, "&order=ASC&format=JSON&outputsize=" + MAX_POINTS
        + "&start_date=" + startDate + "&end_date=" + endDate, apiKey, onWait);
    } catch (e) {
      // A top-up whose whole range is a weekend or holiday comes back as a
      // 400 "No data is available on the specified dates" — that's "nothing
      // new", not a failure.
      if (e.code === 400 && /no data is available/i.test(e.message)) return [];
      throw e;
    }
    if (!json.values) return [];
    return json.values.map(function (v) { return { date: v.datetime.slice(0, 10), close: parseFloat(v.close) }; });
  }

  // The first date Twelve Data has for a symbol (1 credit).
  async function fetchEarliest(symbolCfg, apiKey, onWait) {
    var json = await tdGet("earliest_timestamp", symbolCfg, "", apiKey, onWait);
    if (!json.datetime) throw new Error("no earliest date returned");
    return json.datetime.slice(0, 10);
  }

  // Exchange closures longer than the gap scan's allowance, so they aren't
  // offered as "missing" (fetching them would spend a credit to get nothing).
  var KNOWN_CLOSURES = [
    { from: "2001-09-10", to: "2001-09-17", why: "US markets closed after 9/11" }
  ];

  // Stretches of missing rows in an ascending price series: a gap of more
  // than 1 calendar day for an every-day asset, more than 5 otherwise (a
  // weekend plus two holidays is 5). Only gaps Twelve Data could fill — after
  // its earliest date — are returned; the stored rows before that came from
  // another source.
  function findGaps(rows, everyDay, earliest) {
    var maxDays = everyDay ? 1 : 5;
    var gaps = [];
    for (var i = 1; i < rows.length; i++) {
      var a = rows[i - 1].date, b = rows[i].date;
      var days = dayDiff(a, b);
      if (days <= maxDays || b <= earliest) continue;
      if (KNOWN_CLOSURES.some(function (c) { return c.from === a && c.to === b; })) continue;
      var from = addDaysUTC(a, 1);
      if (from < earliest) from = earliest;
      var to = addDaysUTC(b, -1);
      gaps.push({ from: from, to: to, days: dayDiff(from, to) + 1 });
    }
    return gaps;
  }

  // One call covers up to 5000 rows (~20 years of trading days, ~13 of BTC's
  // every-day series), so a normal top-up is one call per asset however long
  // it's been. Only a multi-decade first backfill needs more. When a range
  // holds more than 5000 rows Twelve Data returns the NEWEST 5000 (whatever
  // `order` says — checked 2026-09-28), so a full page means "older rows
  // remain": page backwards, ending the day before the oldest row received.
  async function fetchTwelveDataRange(symbolCfg, startDate, endDate, apiKey, onWait) {
    var rows = [];
    var to = endDate;
    while (startDate <= to) {
      var page = await fetchTwelveData(symbolCfg, startDate, to, apiKey, onWait);
      rows = page.concat(rows);
      if (page.length < MAX_POINTS) break;
      to = addDaysUTC(page[0].date, -1);
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
      + '<div style="margin-top:8px; font-size:12px; color:var(--ink-soft);">'
      + '<button class="add" id="td-check-btn" style="background:var(--card); color:var(--ink); border-color:var(--line);">Check history</button>'
      + ' finds older history Twelve Data has and gaps in what\'s stored (1 call per asset; nothing is fetched until you choose)'
      + '</div>'
      + '<div id="td-check" style="display:none; margin-top:10px; font-size:12px;"></div>'
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
    var checkBtn = container.querySelector("#td-check-btn");
    var tdCheck = container.querySelector("#td-check");

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
        var onWait = waitReporter(refreshBtn);
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
          refreshBtn.textContent = "Fetching " + asset + "…";
          // One asset failing (bad symbol, daily cap) shouldn't throw away the
          // others already fetched — those credits are spent either way.
          try {
            var rows = await fetchTwelveDataRange(cfg, start, end, apiKey, onWait);
            hideStatus(tdStatus);
            results[asset] = rows;
            lines.push(asset + (isBackfill ? " (full history)" : "") + ": " + rows.length + " new day(s)"
              + (rows.length ? " (" + rows[0].date + " to " + rows[rows.length - 1].date + ")" : ""));
          } catch (e) {
            lines.push(asset + ": couldn't fetch — " + e.message);
          }
        }
        showPreview(results, lines);
      } catch (e) {
        showStatus(tdStatus, "Couldn't fetch: " + e.message, true);
      } finally {
        refreshBtn.disabled = false; refreshBtn.textContent = "Refresh";
      }
    });

    // Lines can carry API error text, so they go in as text, never HTML.
    function showPreview(results, lines) {
      pendingTd = results;
      tdPreviewBody.textContent = "";
      lines.forEach(function (l) { tdPreviewBody.appendChild(document.createTextNode(l)); tdPreviewBody.appendChild(document.createElement("br")); });
      tdPreview.style.display = "block";
    }

    function waitReporter(btn) {
      return function (secs) {
        btn.textContent = "Waiting " + secs + "s…";
        showStatus(tdStatus, "Pausing for Twelve Data's free-plan limit (" + CREDITS_PER_MINUTE
          + " calls a minute) — it'll carry on by itself.", false);
      };
    }

    // History check: step 1 asks Twelve Data for each symbol's earliest date
    // and scans the stored rows for gaps, then lists what could be fetched as
    // ticked boxes; step 2 fetches only the ticked ranges into the normal
    // import preview. Refresh can't find either — it only appends after the
    // newest stored day.
    checkBtn.addEventListener("click", async function () {
      var apiKey = apiKeyInput.value.trim();
      if (!apiKey) { showStatus(tdStatus, "Add your Twelve Data API key first.", true); return; }
      hideStatus(tdStatus);
      tdPreview.style.display = "none";
      tdCheck.style.display = "none";
      checkBtn.disabled = true;
      var onWait = waitReporter(checkBtn);
      var data = ctx.getData();
      var today = todayUTC();
      var notes = [];
      var ranges = [];
      try {
        for (var asset in TWELVEDATA_SYMBOLS) {
          var cfg = TWELVEDATA_SYMBOLS[asset];
          var rows = data[window.App.assetKey(asset)] || [];
          checkBtn.textContent = "Checking " + asset + "…";
          var earliest;
          try {
            earliest = await fetchEarliest(cfg, apiKey, onWait);
            hideStatus(tdStatus);
          } catch (e) {
            notes.push(asset + ": couldn't check — " + e.message);
            continue;
          }
          if (!rows.length) {
            ranges.push({ asset: asset, from: earliest, to: today, what: "full history — nothing stored yet" });
            notes.push(asset + ": nothing stored; Twelve Data has it from " + earliest);
            continue;
          }
          var first = rows[0].date;
          var found = 0;
          if (earliest < first) {
            ranges.push({ asset: asset, from: earliest, to: addDaysUTC(first, -1), what: "older history" });
            found++;
          }
          findGaps(rows, cfg.everyDay, earliest).forEach(function (g) {
            ranges.push({ asset: asset, from: g.from, to: g.to, what: "gap, " + g.days + " day(s) missing" });
            found++;
          });
          notes.push(asset + ": stored " + first + " → " + rows[rows.length - 1].date
            + "; Twelve Data from " + earliest
            + (earliest > first ? " (older rows came from another source)" : "")
            + (found ? "" : " — nothing missing"));
        }
        renderCheck(notes, ranges);
      } catch (e) {
        showStatus(tdStatus, "Couldn't check: " + e.message, true);
      } finally {
        checkBtn.disabled = false; checkBtn.textContent = "Check history";
      }
    });

    function renderCheck(notes, ranges) {
      tdCheck.textContent = "";
      notes.forEach(function (n) {
        var d = document.createElement("div");
        d.style.color = "var(--ink-soft)";
        d.textContent = n;
        tdCheck.appendChild(d);
      });
      if (ranges.length) {
        var boxes = ranges.map(function (r) {
          var label = document.createElement("label");
          label.style.cssText = "display:block; margin-top:6px; color:var(--ink);";
          var cb = document.createElement("input");
          cb.type = "checkbox"; cb.checked = true;
          label.appendChild(cb);
          label.appendChild(document.createTextNode(" " + r.asset + ": " + r.from + " → " + r.to + " (" + r.what + ")"));
          tdCheck.appendChild(label);
          return cb;
        });
        var fetchBtn = document.createElement("button");
        fetchBtn.className = "add";
        fetchBtn.style.marginTop = "8px";
        fetchBtn.textContent = "Fetch selected";
        fetchBtn.addEventListener("click", function () {
          fetchRanges(ranges.filter(function (r, i) { return boxes[i].checked; }), fetchBtn);
        });
        tdCheck.appendChild(fetchBtn);
      }
      tdCheck.style.display = "block";
    }

    async function fetchRanges(ranges, btn) {
      if (!ranges.length) return;
      var apiKey = apiKeyInput.value.trim();
      btn.disabled = true;
      var onWait = waitReporter(btn);
      var results = {};
      var lines = [];
      try {
        for (var i = 0; i < ranges.length; i++) {
          var r = ranges[i];
          btn.textContent = "Fetching " + r.asset + "…";
          try {
            var rows = await fetchTwelveDataRange(TWELVEDATA_SYMBOLS[r.asset], r.from, r.to, apiKey, onWait);
            hideStatus(tdStatus);
            results[r.asset] = (results[r.asset] || []).concat(rows);
            lines.push(r.asset + " " + r.from + " → " + r.to + ": " + rows.length + " day(s)"
              + (rows.length ? "" : " — Twelve Data has none in this range (likely a market closure)"));
          } catch (e) {
            lines.push(r.asset + " " + r.from + " → " + r.to + ": couldn't fetch — " + e.message);
          }
        }
        tdCheck.style.display = "none";
        showPreview(results, lines);
      } finally {
        btn.disabled = false; btn.textContent = "Fetch selected";
      }
    }

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
