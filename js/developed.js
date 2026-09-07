// Developed Strategies tab: every strategy in strategies.json (today, the
// same two as Home), each showing its live status card plus a CAGR row
// backtested on its `backtestAsset` (e.g. the S&P strategy backtests
// against SPX_MERGED for full 1927+ history, while its live badge/meter
// still reads real SPY — see strategies.json). Also hosts the Twelve
// Data / CSV import tools.
window.Developed = (function () {
  var Engine = window.StrategyEngine;
  var RH = window.RenderHelpers;

  function render(container, data, strategies, ctx) {
    var cardsHtml = strategies.map(function (s) {
      var livePrices = data[window.App.assetKey(s.liveAsset)];
      var status = Engine.computeStatus(livePrices, s);

      var backtestPrices = data[window.App.assetKey(s.backtestAsset)];
      var equity = Engine.backtestEquityCurve(backtestPrices, s);
      var cagrs = {
        allTime: Engine.cagr(equity, null),
        y10: Engine.cagr(equity, 10),
        y3: Engine.cagr(equity, 3),
        y1: Engine.cagr(equity, 1)
      };

      var extra = RH.renderCagrRow(cagrs)
        + '<div class="toolsrow">CAGR backtested on ' + s.backtestAsset + ' &middot; ' + backtestPrices.length + ' days on record</div>';

      return RH.renderStatusCard(s, status, extra);
    }).join("");

    container.innerHTML = '<div class="grid2">' + cardsHtml + '</div>' + window.ImportTools.panelHTML();
    window.ImportTools.wireUp(container, ctx);
  }

  return { render: render };
})();
