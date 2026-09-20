// Evaluator — saved strategies scored side by side across fixed time periods.
//
// The Strategy Explorer answers "what is the best setting?". This tab answers
// the harder question: "does that setting hold up outside the stretch of
// history that made it look good?" Hence fixed, non-negotiable periods — five
// decades plus three longer spans — rather than a period picker. A strategy
// that wins one decade and loses two is telling you something the all-time
// number hides.
//
// Every figure comes from StrategyConfig.evaluate, the same pipeline the
// Explorer's matrices use, so a cell here and a cell there can never disagree.
// Each period is compounded fresh from its own start (capital restarts; the
// in/out signal still carries in from before it).
window.Evaluator = (function () {
  var fmt = window.App.fmt;
  var SC = window.StrategyConfig;

  // `to` is exclusive, so a decade runs to 1 Jan of the next one.
  var PERIODS = [
    { key: "2020s", label: "2020s", from: "2020-01-01", to: null, decade: true },
    { key: "2010s", label: "2010s", from: "2010-01-01", to: "2020-01-01", decade: true },
    { key: "2000s", label: "2000s", from: "2000-01-01", to: "2010-01-01", decade: true },
    { key: "1990s", label: "1990s", from: "1990-01-01", to: "2000-01-01", decade: true },
    { key: "1980s", label: "1980s", from: "1980-01-01", to: "1990-01-01", decade: true },
    { key: "70to00", label: "1970–2000", from: "1970-01-01", to: "2000-01-01" },
    { key: "00tonow", label: "2000–now", from: "2000-01-01", to: null },
    { key: "10tonow", label: "2010–now", from: "2010-01-01", to: null }
  ];

  var METRICS = {
    cagr:   { label: "CAGR", unit: "%", get: function (s) { return s.cagr; }, dp: 1, signed: true },
    maxdd:  { label: "Max drawdown", unit: "%", get: function (s) { return s.maxDD; }, dp: 0, signed: false },
    calmar: { label: "Calmar", unit: "", get: function (s) { return s.calmar; }, dp: 2, signed: false }
  };

  var state = { metric: "cagr", renaming: null };

  var RAMP_NEG = ["neg4", "neg3", "neg2", "neg1"];
  var RAMP_POS = ["pos1", "pos2", "pos3", "pos4"];

  // Colour is RELATIVE TO THE COLUMN: every period has its own market backdrop,
  // so an absolute scale would just show that the 1990s were kind and the 2000s
  // were not. Here the question is which strategy won a given period.
  function columnClass(v, values) {
    if (v == null || !isFinite(v)) return "cell-na";
    var fin = values.filter(function (x) { return x != null && isFinite(x); });
    if (fin.length < 2) return "cell-mid";
    var lo = Math.min.apply(null, fin), hi = Math.max.apply(null, fin);
    if (hi - lo < 1e-9) return "cell-mid";
    var t = (v - lo) / (hi - lo);            // 0 = worst in this period, 1 = best
    if (t >= 0.5) return "cell-" + RAMP_POS[Math.min(3, Math.floor((t - 0.5) * 8))];
    return "cell-" + RAMP_NEG[Math.min(3, Math.floor(t * 8))];
  }

  function envFor(data, refRates, costAssumptions, assetKey, period) {
    var asset = SC.assetConfig(assetKey);
    var prices = data[window.App.assetKey(asset.backtestAsset)];
    if (!prices || !prices.length) return null;
    var costs = SC.costConfigFor(costAssumptions, assetKey);
    var ec = SC.engineCostsFrom(costs, refRates);
    return {
      prices: prices, costs: costs, ec: ec, period: period,
      stamp: assetKey + "|" + prices.length + "|" + prices[prices.length - 1].date,
      costSig: JSON.stringify([assetKey, ec.products, ec.slippageBpsRoundTrip])
    };
  }

  function cellText(s, metric) {
    if (!s || s.invalid) return { cls: "cell-na", html: '<span class="c-main">—</span>', v: null };
    if (s.insufficient) return { cls: "cell-na", html: '<span class="c-main">—</span>', v: null };
    if (s.ruined) return { cls: "cell-ruined", html: '<span class="c-main">RUINED</span><span class="c-sub">' + (s.ruinDate ? s.ruinDate.slice(0, 4) : "") + '</span>', v: null };
    var m = METRICS[metric], v = m.get(s);
    if (v == null || !isFinite(v)) return { cls: "cell-na", html: '<span class="c-main">—</span>', v: null };
    var main = (m.signed && v >= 0 ? "+" : "") + fmt(v, m.dp) + m.unit;
    var sub = metric === "cagr" ? fmt(s.maxDD, 0) + "%" : (metric === "maxdd" ? (s.cagr >= 0 ? "+" : "") + fmt(s.cagr, 0) + "%" : "");
    return { cls: null, html: '<span class="c-main">' + main + '</span>' + (sub ? '<span class="c-sub">' + sub + '</span>' : ""), v: v };
  }

  function tooltip(label, period, s) {
    if (!s || s.invalid) return label + " — " + period.label + ": cannot run (" + ((s && s.invalid) || "invalid") + ")";
    if (s.insufficient) return label + " — " + period.label + ": not enough price history in this window";
    if (s.ruined) return label + " — " + period.label + ": WIPED OUT" + (s.ruinDate ? " on " + s.ruinDate : "");
    return label + " — " + period.label + " (" + s.from + " → " + s.to + ", net of costs)"
      + "\nCAGR " + fmt(s.cagr, 1) + "%   max drawdown " + fmt(s.maxDD, 1) + "%"
      + "\nCalmar " + (s.calmar == null ? "—" : fmt(s.calmar, 2))
      + "\n" + fmt(s.tradesPerYear, 1) + " round trips/yr over " + fmt(s.years, 1) + " years";
  }

  function emptyHTML() {
    return '<div class="panel"><h2>Evaluator</h2>'
      + '<div class="toolsrow" style="margin-top:0;">Nothing saved yet. Build a strategy on the <strong>Strategy Explorer</strong> tab — set it up in the parameter bar, or click a matrix cell — then press <strong>Save to Evaluator</strong>. '
      + 'Save two or more and this tab scores them side by side across five decades and three longer spans, so you can see which ones hold up outside the stretch of history that made them look good.</div>'
      + '<div class="toolsrow">Saved strategies are kept in this browser only (local storage) — they are not in the repo and do not sync between devices.</div>'
      + '</div>';
  }

  function render(container, data, costAssumptions, refRates) {
    var list = SC.saved();
    if (!list.length) { container.innerHTML = emptyHTML(); wire(container, data, costAssumptions, refRates); return; }

    // Score everything first: rows x periods, plus one benchmark row per asset in use.
    var assetsUsed = [];
    list.forEach(function (e) { if (assetsUsed.indexOf(e.asset) < 0) assetsUsed.push(e.asset); });

    var rows = list.map(function (e) {
      var gs = null, cells = PERIODS.map(function (p, pi) {
        var env = envFor(data, refRates, costAssumptions, e.asset, p);
        if (!env) return { missing: true };
        if (!gs) gs = (SC.resolve(e, env.costs).gs) || null;
        return SC.evaluate(env, e);
      });
      return { entry: e, cells: cells, gs: gs, label: e.name || SC.describe(e, gs) };
    });
    var bench = assetsUsed.map(function (key) {
      return {
        assetKey: key, label: "Buy & hold 1× — " + SC.assetConfig(key).label,
        cells: PERIODS.map(function (p, pi) {
          var env = envFor(data, refRates, costAssumptions, key, p);
          return env ? SC.benchmark(env) : { missing: true };
        })
      };
    });

    var metric = METRICS[state.metric];
    // Column scale spans strategies AND benchmarks, so "beat buy & hold" is visible.
    var colValues = PERIODS.map(function (p, pi) {
      return rows.concat(bench).map(function (r) { return cellText(r.cells[pi], state.metric).v; });
    });

    function bodyRow(r, isBench) {
      var tds = PERIODS.map(function (p, pi) {
        var s = r.cells[pi];
        var c = cellText(s, state.metric);
        var cls = c.cls || columnClass(c.v, colValues[pi]);
        return '<td class="mcell ' + cls + '" title="' + tooltip(r.label, p, s).replace(/"/g, "&quot;") + '">' + c.html + '</td>';
      }).join("");

      // Summary over the five decades only — the three spans overlap them, so
      // averaging everything would double-count the recent past.
      var dec = PERIODS.map(function (p, pi) { return p.decade ? r.cells[pi] : null; })
                       .filter(function (s) { return s && !s.invalid && !s.insufficient && !s.missing; });
      var ok = dec.filter(function (s) { return !s.ruined; }).map(function (s) { return metric.get(s); })
                  .filter(function (v) { return v != null && isFinite(v); });
      var anyRuin = dec.some(function (s) { return s.ruined; });
      var mean = ok.length ? ok.reduce(function (a, b) { return a + b; }, 0) / ok.length : null;
      var worst = anyRuin ? null : (ok.length ? Math.min.apply(null, ok) : null);
      var beat = "—";
      if (!isBench) {
        var b = bench.filter(function (x) { return x.assetKey === r.entry.asset; })[0];
        if (b) {
          var n = 0, tot = 0;
          PERIODS.forEach(function (p, pi) {
            if (!p.decade) return;
            var a = r.cells[pi], c = b.cells[pi];
            if (!a || a.invalid || a.insufficient || a.missing || !c || c.insufficient || c.missing) return;
            tot++;
            if (!a.ruined && a.cagr > c.cagr) n++;
          });
          beat = tot ? n + " / " + tot : "—";
        }
      }
      return '<tr' + (isBench ? ' class="bench-row"' : '') + '>'
        + '<th class="ev-name">' + (isBench ? '<span class="muted">' + r.label + '</span>'
            : '<span class="ev-title">' + r.label + '</span><span class="ev-sub">' + SC.assetConfig(r.entry.asset).label + ' · ' + SC.describe(r.entry, r.gs) + '</span>')
        + '</th>' + tds
        + '<td class="ev-sum">' + (mean == null ? "—" : (metric.signed && mean >= 0 ? "+" : "") + fmt(mean, metric.dp) + metric.unit) + '</td>'
        + '<td class="ev-sum">' + (anyRuin ? '<span style="color:var(--warn)">ruin</span>' : worst == null ? "—" : (metric.signed && worst >= 0 ? "+" : "") + fmt(worst, metric.dp) + metric.unit) + '</td>'
        + '<td class="ev-sum">' + beat + '</td>'
        + '</tr>';
    }

    var head = '<tr><th class="corner">Strategy</th>'
      + PERIODS.map(function (p) { return '<th' + (p.decade ? '' : ' class="span-col"') + '>' + p.label + '</th>'; }).join("")
      + '<th class="ev-sum">Mean<br><span class="muted">decades</span></th>'
      + '<th class="ev-sum">Worst<br><span class="muted">decade</span></th>'
      + '<th class="ev-sum">Beat 1×<br><span class="muted">decades</span></th></tr>';

    var missingAssets = assetsUsed.filter(function (k) {
      var a = SC.assetConfig(k), p = data[window.App.assetKey(a.backtestAsset)];
      return !p || !p.length;
    }).map(function (k) { return SC.assetConfig(k).label; });

    var html = '<div class="panel">'
      + '<div class="detail-head"><h2>Evaluator — ' + list.length + ' saved strateg' + (list.length === 1 ? "y" : "ies") + '</h2>'
      + '<div class="winbtns">'
      + Object.keys(METRICS).map(function (k) {
          return '<button class="winbtn' + (k === state.metric ? " active" : "") + '" data-ev-metric="' + k + '">' + METRICS[k].label + '</button>';
        }).join("")
      + '</div></div>'
      + (missingAssets.length ? '<div class="fatal">No price history loaded for ' + missingAssets.join(", ") + ' — those rows are blank until you import it on the Strategy Explorer tab.</div>' : "")
      + '<div class="matrixwrap"><table class="matrix evaluator"><thead>' + head + '</thead><tbody>'
      + rows.map(function (r) { return bodyRow(r, false); }).join("")
      + bench.map(function (b) { return bodyRow(b, true); }).join("")
      + '</tbody></table></div>'
      + '<div class="toolsrow">Showing <strong>' + metric.label + '</strong>'
      + (state.metric === "cagr" ? ', with max drawdown underneath' : state.metric === "maxdd" ? ', with CAGR underneath' : '')
      + '. Colour compares strategies <em>within each period</em> — every decade has its own market backdrop, so an absolute scale would only show you which decades were kind. '
      + 'The last three columns overlap the decades, so <strong>Mean</strong> and <strong>Worst</strong> use the five decades only. '
      + 'Each period is compounded fresh from its own start, net of costs; the in/out signal still carries in from before it. '
      + 'A strategy that wins one decade and loses two is telling you something its all-time number hides.</div>'
      + '</div>';

    html += manageHTML(list);
    container.innerHTML = html;
    wire(container, data, costAssumptions, refRates);
  }

  function manageHTML(list) {
    return '<div class="panel"><h2>Saved strategies</h2>'
      + '<div class="ev-manage">' + list.map(function (e, i) {
        var gs = null;
        return '<div class="ev-item">'
          + (state.renaming === e.id
            ? '<input class="ev-rename" data-rename-id="' + e.id + '" value="' + (e.name || "").replace(/"/g, "&quot;") + '" placeholder="name this strategy">'
            : '<span class="ev-item-name">' + (e.name || SC.describe(e, null)) + '</span>')
          + '<span class="ev-item-sub">' + SC.assetConfig(e.asset).label + ' · ' + SC.describe(e, null) + '</span>'
          + '<span class="ev-item-btns">'
          + '<button class="winbtn" data-move="' + e.id + '" data-dir="-1"' + (i === 0 ? " disabled" : "") + ' title="Move up">↑</button>'
          + '<button class="winbtn" data-move="' + e.id + '" data-dir="1"' + (i === list.length - 1 ? " disabled" : "") + ' title="Move down">↓</button>'
          + '<button class="winbtn" data-rename="' + e.id + '">' + (state.renaming === e.id ? "Done" : "Rename") + '</button>'
          + '<button class="winbtn" data-del="' + e.id + '" title="Remove this saved strategy">Remove</button>'
          + '</span></div>';
      }).join("") + '</div>'
      + '<div class="toolsrow">Up to ' + SC.MAX_SAVED + ' strategies, kept in this browser only (local storage) — not in the repo, and not synced between devices. '
      + 'Costs use the slippage tier and any fee edits set on the Strategy Explorer tab, so both tabs always agree.</div>'
      + '</div>';
  }

  function wire(container, data, costAssumptions, refRates) {
    function rerender() { render(container, data, costAssumptions, refRates); }
    function bind(sel, fn) {
      container.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function () { if (el.disabled) return; fn(el); rerender(); });
      });
    }
    bind("[data-ev-metric]", function (el) { state.metric = el.getAttribute("data-ev-metric"); });
    bind("[data-del]", function (el) { SC.remove(el.getAttribute("data-del")); state.renaming = null; });
    bind("[data-move]", function (el) { SC.reorder(el.getAttribute("data-move"), Number(el.getAttribute("data-dir"))); });
    bind("[data-rename]", function (el) {
      var id = el.getAttribute("data-rename");
      if (state.renaming === id) {
        var input = container.querySelector('[data-rename-id="' + id + '"]');
        if (input) SC.rename(id, input.value.trim());
        state.renaming = null;
      } else state.renaming = id;
    });
    var ren = container.querySelector(".ev-rename");
    if (ren) {
      ren.focus();
      ren.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { SC.rename(ren.getAttribute("data-rename-id"), ren.value.trim()); state.renaming = null; rerender(); }
        if (e.key === "Escape") { state.renaming = null; rerender(); }
      });
    }
  }

  return { render: render };
})();
