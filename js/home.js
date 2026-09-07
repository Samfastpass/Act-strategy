// Home tab: live status cards for every "active" strategy in
// strategies.json, plus the daily quick-entry form and history table.
window.Home = (function () {
  var fmt = window.App.fmt;

  function render(container, data, strategies, ctx) {
    var activeStrategies = strategies.filter(function (s) { return s.active; });

    var cardsHtml = activeStrategies.map(function (s) {
      var prices = data[window.App.assetKey(s.liveAsset)];
      var status = window.StrategyEngine.computeStatus(prices, s);
      return window.RenderHelpers.renderStatusCard(s, status, "");
    }).join("");

    var lastDate = data.btc.length ? data.btc[data.btc.length - 1].date : "";

    var histRows = data.btc.slice().reverse().slice(0, 12).map(function (b) {
      var s = data.spy.filter(function (p) { return p.date === b.date; })[0];
      return "<tr><td>" + b.date + "</td><td>" + fmt(b.close, 0) + "</td><td>" + (s ? fmt(s.close, 2) : "&mdash;") + "</td></tr>";
    }).join("");

    container.innerHTML =
      '<div class="grid2">' + cardsHtml + '</div>'
      + '<div class="panel"><h2>Log today&#8217;s close</h2>'
      + '<div class="formrow">'
      + '<div class="field"><label>Date</label><input type="date" id="in-date"></div>'
      + '<div class="field"><label>BTC close (USD)</label><input type="number" step="0.01" id="in-btc" placeholder="' + (data.btc.length ? fmt(data.btc[data.btc.length - 1].close, 0) : "") + '"></div>'
      + '<div class="field"><label>SPY close (USD)</label><input type="number" step="0.01" id="in-spy" placeholder="' + (data.spy.length ? fmt(data.spy[data.spy.length - 1].close, 2) : "") + '"></div>'
      + '<button class="add" id="btn-add">Add entry</button>'
      + '</div>'
      + '<div id="err" class="errtext" style="display:none;"></div>'
      + '</div>'
      + '<div class="panel"><h2>History</h2>'
      + '<div class="histwrap"><table class="hist"><thead><tr><th>Date</th><th>BTC</th><th>SPY</th></tr></thead><tbody>' + histRows + '</tbody></table></div>'
      + '<div class="toolsrow">' + data.btc.length + ' BTC days &middot; ' + data.spy.length + ' SPY days on record, both computed fresh from full history each load</div>'
      + '</div>';

    var dateInput = container.querySelector("#in-date");
    var today = new Date(); dateInput.value = today.toISOString().slice(0, 10);

    container.querySelector("#btn-add").onclick = async function () {
      var err = container.querySelector("#err");
      err.style.display = "none";
      var date = container.querySelector("#in-date").value;
      var btcVal = parseFloat(container.querySelector("#in-btc").value);
      var spyVal = parseFloat(container.querySelector("#in-spy").value);
      if (!date) { err.textContent = "Pick a date first."; err.style.display = "block"; return; }
      if (isNaN(btcVal) && isNaN(spyVal)) { err.textContent = "Enter at least one price."; err.style.display = "block"; return; }

      var rows = [];
      if (!isNaN(btcVal)) rows.push({ asset: "BTC", date: date, close: btcVal });
      if (!isNaN(spyVal)) rows.push({ asset: "SPY", date: date, close: spyVal });

      var btn = container.querySelector("#btn-add");
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        var r = await ctx.sb.from("prices").upsert(rows, { onConflict: "asset,date" });
        if (r.error) throw new Error(r.error.message);
        await ctx.onImported();
      } catch (e) {
        err.textContent = "Couldn't save: " + e.message;
        err.style.display = "block";
        btn.disabled = false; btn.textContent = "Add entry";
      }
    };
  }

  return { render: render };
})();
