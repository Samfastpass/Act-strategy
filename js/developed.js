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
  // A window taken from a chart zoom ({ from, to }, to exclusive); overrides
  // chartYears until cleared, a year button is pressed, or another card opens.
  var chartRange = null;
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
    var ec = netCosts(strategy, costAssumptions, refRates);
    // A cost cap decides positions from real rates and products, so even the
    // gross curve is given `ec` to decide with (it just isn't charged costs).
    var status = Engine.computeStatus(livePrices, strategy, ec);
    var equity = Engine.backtestEquityCurve(backtestPrices, strategy, null, ec);
    var netEquity = ec ? Engine.backtestEquityCurve(backtestPrices, strategy, ec) : null;
    // Buy & hold for the chart: 1x, cost-free, but with dividends reinvested
    // when the series is price-only (as on the Explorer) — the strategy
    // receives them, so a benchmark without them would flatter it.
    var hold = null;
    if (ec && ec.dividendYieldForDate && equity.length) {
      var lo = backtestPrices.findIndex(function (p) { return p.date === equity[0].date; });
      var ones = new Array(backtestPrices.length).fill(1);
      hold = Engine.compoundEquity(backtestPrices, ones, lo, backtestPrices.length - 1,
        { products: [{ leverage: 1 }], dividendYieldForDate: ec.dividendYieldForDate });
    }
    // Odds come from the backtest series (more history) using that series'
    // own walk, so episodes and extensions line up with the equity curve.
    var backtestWalk = Engine.walk(backtestPrices, strategy);
    if (strategy.costCap > 0 && ec) {
      // What was actually held each day, for the chart's blocks and strip.
      var capAt = Engine.costCapLimits(backtestPrices, strategy.costCap, ec), outL = strategy.outLeverage || 0;
      backtestWalk.held = backtestWalk.state.map(function (st, i) { return Math.min(st > 0 ? st : outL, capAt[i]); });
    }
    var backtestStatus = Engine.computeStatus(backtestPrices, strategy);
    return {
      strategy: strategy, status: status, equity: equity, netEquity: netEquity, hold: hold,
      backtestPrices: backtestPrices, backtestWalk: backtestWalk,
      odds: window.Odds.compute(backtestPrices, strategy, backtestWalk, backtestStatus),
      cagrs: cagrsOf(equity),
      netCagrs: netEquity ? cagrsOf(netEquity) : null,
      netRuined: netEquity ? netEquity.ruinedAt : null
    };
  }

  // Net CAGRs and any cost cap depend on the cost inputs being current; say so
  // (once, for every asset on the tab) when the rates or product terms are overdue.
  function staleNoteHTML(strategies, costAssumptions, refRates) {
    if (!costAssumptions || !refRates) return "";
    var SC = window.StrategyConfig, msgs = {};
    strategies.forEach(function (s) {
      var key = window.StrategyStore.costKeyFor(s);
      if (!key) return;
      var f = SC.freshness(refRates, SC.costConfigFor(costAssumptions, key));
      if (f.rate && f.rate.stale) msgs["r" + f.rate.name] = f.rate.name + " was last updated " + f.rate.date + " (" + f.rate.days + " days ago)";
      if (f.terms && f.terms.stale) msgs["t" + key] = key + " product terms were last checked " + f.terms.date;
    });
    var list = Object.keys(msgs).map(function (k) { return msgs[k]; });
    if (!list.length) return "";
    return '<div class="fresh-warn"><strong>Cost inputs are out of date:</strong> ' + list.join("; ")
      + '. Net returns and cost-cap positions assume nothing has changed since. See the Costs panel on the Strategy Explorer.</div>';
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
      return '<button class="winbtn' + (!chartRange && w.years === chartYears ? " active" : "") + '" data-years="'
        + (w.years == null ? "all" : w.years) + '">' + w.label + '</button>';
    }).join("")
      + (chartRange ? '<button class="winbtn active" data-range-clear="1" title="Back to the year buttons">' + rangeLabel(chartRange) + ' &times;</button>' : '');
    // The chart's zoom is offered as its window; it resets when what's on screen changes.
    window.Plot.linkKey("developed", a.strategy.id + "|" + (chartRange ? rangeLabel(chartRange) : chartYears));

    return '<div class="panel detail">'
      + '<div class="detail-head"><h2>' + a.strategy.name + ' &mdash; strategy vs. buy &amp; hold</h2>'
      + '<div class="winbtns">' + buttons + '</div></div>'
      + window.Chart.render(a.strategy, a.backtestPrices, { net: a.netEquity, gross: a.equity, hold: a.hold }, a.backtestWalk, chartYears, chartRange,
          "fees, financing and " + window.StrategyConfig.session.slippageTier + " slippage")
      + '<div class="toolsrow">Backtested on ' + a.strategy.backtestAsset + ' &middot; '
      + a.backtestPrices.length + ' days on record'
      + (a.strategy.execution ? ' &middot; ' + a.strategy.execution : '')
      + '</div>'
      + '</div>'
      + '<div class="zoom-bar" id="dev-zoombar" hidden><span>Zoomed to <strong class="zb-range"></strong></span>'
      + '<button class="winbtn active" data-dev-zoom-apply="1" title="Redraw the chart from this range, rebased to 1× on its first day">Use as the window</button>'
      + '<span class="muted">double-click the chart to zoom out</span></div>'
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

    container.innerHTML = window.StrategyStore.setupNoteHTML() + staleNoteHTML(strategies, costAssumptions, refRates)
      + (strategies.length ? '<div class="grid2">' + cardsHtml + '</div>'
         : '<div class="panel"><div class="toolsrow" style="margin-top:0;">No strategies yet. Build one on the <strong>Strategy Explorer</strong> and press <strong>Add to Developed</strong>, or add a saved one from the <strong>Evaluator</strong>.</div></div>')
      + (selected ? detailPanel(selected) : "")
      + window.ImportTools.panelHTML();

    container.querySelectorAll(".card-click").forEach(function (card) {
      function toggle() {
        var id = card.getAttribute("data-strategy-id");
        selectedId = (selectedId === id) ? null : id;
        chartRange = null;
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
        chartRange = null;
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
    var clearBtn = container.querySelector("[data-range-clear]");
    if (clearBtn) clearBtn.addEventListener("click", function () { chartRange = null; rerender(); });
    var zoomBar = container.querySelector("#dev-zoombar");
    function showZoom(range) {
      if (!zoomBar) return;
      zoomBar.hidden = !range;
      if (range) zoomBar.querySelector(".zb-range").textContent = range[0] + " → " + range[1];
    }
    window.Plot.onRange("developed", showZoom);
    showZoom(window.Plot.groupRange("developed"));
    var applyBtn = container.querySelector("[data-dev-zoom-apply]");
    if (applyBtn) applyBtn.addEventListener("click", function () {
      var r = window.Plot.groupRange("developed");
      var a = analyses.filter(function (x) { return !x.missing && x.strategy.id === selectedId; })[0];
      if (!r || !a) return;
      var last = a.backtestPrices[a.backtestPrices.length - 1].date;
      chartRange = { from: r[0], to: r[1] >= last ? null : shiftDay(r[1], 1) };
      rerender();
    });

    window.Plot.mount(container);
  }

  function shiftDay(d, n) {
    var t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  // `to` is exclusive; the label shows the last day included.
  function rangeLabel(r) { return (r.from || "start") + " → " + (r.to ? shiftDay(r.to, -1) : "today"); }

  return { render: render };
})();
