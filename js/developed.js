// Developed Strategies tab: every stored strategy (js/strategy-store.js — on
// Home or not, shelved or not), each with Show-on-Home / Delete buttons and
// its live status card plus gross and net-of-costs CAGR rows backtested on
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

  // Net of the same product costs the Explorer and Evaluator use (fees,
  // financing, dividends, the session's slippage tier), so a strategy added
  // from there shows the same net number here.
  function netCosts(strategy, costAssumptions, refRates) {
    var key = window.StrategyStore.costKeyFor(strategy);
    if (!key || !costAssumptions) return null;
    var SC = window.StrategyConfig;
    return SC.engineCostsFrom(SC.costConfigFor(costAssumptions, key), refRates);
  }

  function cagrsOf(equity) {
    return {
      allTime: Engine.cagr(equity, null), y10: Engine.cagr(equity, 10),
      y3: Engine.cagr(equity, 3), y1: Engine.cagr(equity, 1)
    };
  }

  function analyse(strategy, data, costAssumptions, refRates) {
    var livePrices = data[window.App.assetKey(strategy.liveAsset)];
    var backtestPrices = data[window.App.assetKey(strategy.backtestAsset)];
    if (!livePrices || !livePrices.length || !backtestPrices || !backtestPrices.length) {
      return { strategy: strategy, missing: true };
    }
    var status = Engine.computeStatus(livePrices, strategy);
    var equity = Engine.backtestEquityCurve(backtestPrices, strategy);
    var ec = netCosts(strategy, costAssumptions, refRates);
    var netEquity = ec ? Engine.backtestEquityCurve(backtestPrices, strategy, ec) : null;
    // Odds come from the backtest series (more history) using that series'
    // own walk, so episodes and extensions line up with the equity curve.
    var backtestWalk = Engine.walk(backtestPrices, strategy);
    var backtestStatus = Engine.computeStatus(backtestPrices, strategy);
    return {
      strategy: strategy, status: status, equity: equity,
      backtestPrices: backtestPrices, backtestWalk: backtestWalk,
      odds: window.Odds.compute(backtestPrices, strategy, backtestWalk, backtestStatus),
      cagrs: cagrsOf(equity),
      netCagrs: netEquity ? cagrsOf(netEquity) : null,
      netRuined: netEquity ? netEquity.ruinedAt : null
    };
  }

  function actionsHTML(s) {
    var ro = window.StrategyStore.isReadOnly();
    var dis = ro ? ' disabled title="Run supabase/strategies.sql in Supabase to enable"' : '';
    return '<div class="card-actions">'
      + '<button class="winbtn" data-act="home" data-id="' + s.id + '"' + dis + '>' + (s.active ? "Remove from Home" : "Show on Home") + '</button>'
      + '<button class="winbtn" data-act="delete" data-id="' + s.id + '"' + dis + '>Delete</button>'
      + '</div>';
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

  function render(container, data, strategies, ctx, costAssumptions, refRates) {
    function rerender() { render(container, data, strategies, ctx, costAssumptions, refRates); }
    var analyses = strategies.map(function (s) { return analyse(s, data, costAssumptions, refRates); });

    var cardsHtml = analyses.map(function (a) {
      if (a.missing) {
        return '<div class="card"><div class="card-head"><div><div class="name">' + a.strategy.name + '</div>'
          + '<div class="sub">No price history loaded for ' + a.strategy.backtestAsset + ' yet — import it on the Strategy Explorer tab.</div></div></div>'
          + actionsHTML(a.strategy) + '</div>';
      }
      var extra = RH.renderCagrRow(a.cagrs, a.netCagrs ? "CAGR, gross (before any costs)" : null)
        + (a.netCagrs ? RH.renderCagrRow(a.netCagrs, "CAGR, net of fees, financing &amp; "
            + window.StrategyConfig.session.slippageTier + " slippage"
            + (a.netRuined ? ' &mdash; <span style="color:var(--warn)">wiped out ' + a.netRuined + '</span>' : '')) : "")
        + RH.oddsOneLiner(a.odds)
        + '<div class="toolsrow">CAGR backtested on ' + a.strategy.backtestAsset + ' &middot; '
        + a.backtestPrices.length + ' days &middot; <span class="expandhint">'
        + (a.strategy.id === selectedId ? 'click to close' : 'click for chart &amp; odds') + '</span></div>'
        + actionsHTML(a.strategy);
      return RH.renderStatusCard(a.strategy, a.status, extra, {
        clickable: true,
        selected: a.strategy.id === selectedId,
        homeBadge: true
      });
    }).join("");

    var selected = analyses.filter(function (a) { return !a.missing && a.strategy.id === selectedId; })[0];

    container.innerHTML = window.StrategyStore.setupNoteHTML()
      + (strategies.length ? '<div class="grid2">' + cardsHtml + '</div>'
         : '<div class="panel"><div class="toolsrow" style="margin-top:0;">No strategies yet. Build one on the <strong>Strategy Explorer</strong> and press <strong>Add to Developed</strong>, or add a saved one from the <strong>Evaluator</strong>.</div></div>')
      + (selected ? detailPanel(selected) : "")
      + window.ImportTools.panelHTML();

    container.querySelectorAll(".card-click").forEach(function (card) {
      function toggle() {
        var id = card.getAttribute("data-strategy-id");
        selectedId = (selectedId === id) ? null : id;
        rerender();
      }
      card.addEventListener("click", function (e) { if (!e.target.closest(".card-actions")) toggle(); });
      card.addEventListener("keydown", function (e) {
        if (e.target !== card) return;   // Enter on a card's own button isn't "open the card"
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });

    container.querySelectorAll("[data-years]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-years");
        chartYears = v === "all" ? null : Number(v);
        rerender();
      });
    });

    container.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (btn.disabled) return;
        var id = btn.getAttribute("data-id");
        var s = strategies.filter(function (x) { return x.id === id; })[0];
        if (!s) return;
        if (btn.getAttribute("data-act") === "delete"
            && !window.confirm("Delete “" + (s.rawName || s.name) + "” from the Developed tab" + (s.active ? " and Home" : "") + "? This can't be undone.")) return;
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          if (btn.getAttribute("data-act") === "delete") {
            await window.StrategyStore.remove(id);
            if (selectedId === id) selectedId = null;
          } else {
            await window.StrategyStore.setOnHome(id, !s.active);
          }
          await ctx.onStrategiesChanged();
        } catch (err) {
          btn.disabled = false; btn.textContent = "Failed — " + err.message;
        }
      });
    });

    window.ImportTools.wireUp(container, ctx);
  }

  return { render: render };
})();
