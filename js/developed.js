// Developed Strategies tab: every strategy in strategies.json (active and
// shelved), each showing its live status card plus a CAGR row backtested on
// its `backtestAsset` (e.g. the S&P strategy backtests against SPX_MERGED
// for full 1927+ history, while its live badge/meter still reads real SPY).
// Clicking a card opens a full-width detail panel with an equity chart and
// the odds table — full width because a chart squeezed into a half-width
// card is unreadable.
window.Developed = (function () {
  var Engine = window.StrategyEngine;
  var RH = window.RenderHelpers;

  // Persist across re-renders (a data refresh re-runs render()).
  var selectedId = null;
  var chartYears = 5;
  var WINDOWS = [
    { label: "1y", years: 1 }, { label: "3y", years: 3 }, { label: "5y", years: 5 },
    { label: "10y", years: 10 }, { label: "All", years: null }
  ];

  function analyse(strategy, data) {
    var livePrices = data[window.App.assetKey(strategy.liveAsset)];
    var backtestPrices = data[window.App.assetKey(strategy.backtestAsset)];
    var status = Engine.computeStatus(livePrices, strategy);
    var equity = Engine.backtestEquityCurve(backtestPrices, strategy);
    // Odds come from the backtest series (more history) using that series'
    // own walk, so episodes and extensions line up with the equity curve.
    var backtestWalk = Engine.walk(backtestPrices, strategy);
    var backtestStatus = Engine.computeStatus(backtestPrices, strategy);
    return {
      strategy: strategy, status: status, equity: equity,
      backtestPrices: backtestPrices, backtestWalk: backtestWalk,
      odds: window.Odds.compute(backtestPrices, strategy, backtestWalk, backtestStatus),
      cagrs: {
        allTime: Engine.cagr(equity, null),
        y10: Engine.cagr(equity, 10),
        y3: Engine.cagr(equity, 3),
        y1: Engine.cagr(equity, 1)
      }
    };
  }

  function detailPanel(a) {
    var buttons = WINDOWS.map(function (w) {
      return '<button class="winbtn' + (w.years === chartYears ? " active" : "") + '" data-years="'
        + (w.years == null ? "all" : w.years) + '">' + w.label + '</button>';
    }).join("");

    return '<div class="panel detail">'
      + '<div class="detail-head"><h2>' + a.strategy.name + ' &mdash; strategy vs. buy &amp; hold</h2>'
      + '<div class="winbtns">' + buttons + '</div></div>'
      + window.Chart.render(a.strategy, a.backtestPrices, a.equity, a.backtestWalk, chartYears)
      + '<div class="toolsrow">Backtested on ' + a.strategy.backtestAsset + ' &middot; '
      + a.backtestPrices.length + ' days on record'
      + (a.strategy.execution ? ' &middot; ' + a.strategy.execution : '')
      + '</div>'
      + '</div>'
      + RH.renderOddsTable(a.odds);
  }

  function render(container, data, strategies, ctx) {
    var analyses = strategies.map(function (s) { return analyse(s, data); });

    var cardsHtml = analyses.map(function (a) {
      var extra = RH.renderCagrRow(a.cagrs)
        + RH.oddsOneLiner(a.odds)
        + '<div class="toolsrow">CAGR backtested on ' + a.strategy.backtestAsset + ' &middot; '
        + a.backtestPrices.length + ' days &middot; <span class="expandhint">'
        + (a.strategy.id === selectedId ? 'click to close' : 'click for chart &amp; odds') + '</span></div>';
      return RH.renderStatusCard(a.strategy, a.status, extra, {
        clickable: true,
        selected: a.strategy.id === selectedId
      });
    }).join("");

    var selected = analyses.filter(function (a) { return a.strategy.id === selectedId; })[0];

    container.innerHTML = '<div class="grid2">' + cardsHtml + '</div>'
      + (selected ? detailPanel(selected) : "")
      + window.ImportTools.panelHTML();

    container.querySelectorAll(".card-click").forEach(function (card) {
      function toggle() {
        var id = card.getAttribute("data-strategy-id");
        selectedId = (selectedId === id) ? null : id;
        render(container, data, strategies, ctx);
      }
      card.addEventListener("click", toggle);
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });

    container.querySelectorAll(".winbtn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-years");
        chartYears = v === "all" ? null : Number(v);
        render(container, data, strategies, ctx);
      });
    });

    window.ImportTools.wireUp(container, ctx);
  }

  return { render: render };
})();
