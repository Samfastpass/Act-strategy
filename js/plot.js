// Interactive charts: the one place that touches Plotly.
//
// The chart modules (chart.js, price-chart.js, perf-chart.js, fee-chart.js)
// still compute everything they show — this file only draws it. They return
// HTML strings like the rest of the app, so a chart can't be drawn at render
// time: a renderer calls slot(spec), which returns a placeholder div and
// remembers `spec`, and the caller calls mount(root) once that HTML is in the
// page. Four lifecycle rules, each from a way this goes wrong:
//
//  - Only VISIBLE slots are drawn. Every tab is built at load while hidden,
//    and Plotly sizes a hidden div to nothing. app.js's switchTab calls
//    mount() on the tab it shows.
//  - Plotly (~400 KB gzipped) loads on the first visible chart, so the Home
//    tab never downloads it. A pinned version with an SRI hash; if it can't
//    load, the slot says so and the rest of the tab is unaffected.
//  - The Explorer rebuilds its whole innerHTML on every click, so plots whose
//    div has left the page are purged on every mount (Plotly keeps resize
//    listeners per plot).
//  - Charts in a link group share their x range: zoom one and the others
//    follow, and the range survives a rerender until the group's key (the
//    asset and period on screen) changes.
//
// Colours come from the page's CSS variables, read at draw time, and every
// plot is redrawn when the OS switches between light and dark.
window.Plot = (function () {
  var SRC = "https://cdn.jsdelivr.net/npm/plotly.js-basic-dist-min@4.1.2/plotly-basic.min.js";
  var SRI = "sha384-CQVnjjRLr7qiE0NRUOMECQiOsJiFOrqPu+WrTttl7hUk5w+7FaiJA+y3SVfjpksc";

  var pending = {};      // slot id -> spec, until drawn
  var mounted = [];      // [{ div, spec }]
  var groups = {};       // link group -> { key, range }
  var nextId = 1;
  var loadState = null;  // null | "loading" | "ready" | "failed"
  var linking = false;   // re-entrancy guard while propagating a zoom

  function load() {
    if (window.Plotly) { loadState = "ready"; return Promise.resolve(); }
    if (load.promise) return load.promise;
    loadState = "loading";
    load.promise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SRC; s.integrity = SRI; s.crossOrigin = "anonymous"; s.async = true;
      s.onload = function () { if (window.Plotly) { loadState = "ready"; resolve(); } else { loadState = "failed"; reject(new Error("Plotly did not initialise")); } };
      s.onerror = function () { loadState = "failed"; reject(new Error("couldn't load " + SRC)); };
      document.head.appendChild(s);
    });
    return load.promise;
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  // #rgb / #rrggbb + alpha -> rgba(); Plotly wants an explicit alpha for fills.
  function alpha(hex, a) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
    if (!/^[0-9a-f]{6}$/i.test(h)) return hex;
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
  }

  function theme() {
    return {
      ink: cssVar("--ink", "#16181c"), inkSoft: cssVar("--ink-soft", "#5b6069"), inkFaint: cssVar("--ink-faint", "#9498a1"),
      line: cssVar("--line", "#e3e5e8"), card: cssVar("--card", "#ffffff"), paper: cssVar("--paper", "#f6f7f9"),
      long: cssVar("--long", "#1a5c3f"), warn: cssVar("--warn", "#9c2b2b"), flat: cssVar("--flat", "#8a6d1d"),
      mono: cssVar("--mono", "ui-monospace, monospace"), alpha: alpha
    };
  }

  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

  // Shared layout defaults; a chart's own layout is merged over this.
  function baseLayout(t, height) {
    var axis = { gridcolor: t.line, linecolor: t.line, zeroline: false, tickfont: { family: t.mono, size: 10, color: t.inkFaint }, automargin: true };
    return {
      height: height, autosize: true,
      margin: { l: 52, r: 14, t: 8, b: 28 },
      // The panel's own colour rather than transparent, so a PNG export
      // isn't light text on a transparent background.
      paper_bgcolor: t.card, plot_bgcolor: t.card,
      font: { family: t.mono, size: 10, color: t.inkSoft },
      showlegend: false,
      hovermode: "x unified",
      hoverlabel: { bgcolor: t.card, bordercolor: t.line, font: { family: t.mono, size: 11, color: t.ink } },
      // Touch drag-to-zoom would trap page scrolling on a phone.
      dragmode: coarse ? false : "zoom",
      xaxis: Object.assign({ type: "date", hoverformat: "%-d %b %Y", showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: t.inkFaint, spikedash: "dot" }, axis),
      yaxis: Object.assign({}, axis)
    };
  }
  function axisStyle(t) {
    return { gridcolor: t.line, linecolor: t.line, zeroline: false, tickfont: { family: t.mono, size: 10, color: t.inkFaint }, automargin: true };
  }

  // A log axis whose labels read as numbers. Plotly's own ticks are good up to
  // about two decades (2×, 3×, 5×, 10×); across more it labels the in-between
  // ticks with bare digits ("2", "5") that lose their magnitude, so there it
  // ticks at powers of ten only. A tickformat makes things worse on short
  // ranges (it pins ticks at uneven values like 0.967×), so none is set.
  // `min`/`max` are the data's positive extremes.
  function logAxis(min, max, suffix) {
    // The tickmode is always explicit: an axis overlaying another can otherwise
    // sync its ticks to the hidden 0–1 axis underneath, landing them on uneven
    // values. ("auto" ignores dtick, so decades need "linear".)
    var a = { type: "log", exponentformat: "none", separatethousands: true };
    if (suffix) a.ticksuffix = suffix;
    if (min > 0 && max > 0 && Math.log10(max / min) >= 2) { a.tickmode = "linear"; a.tick0 = 0; a.dtick = 1; }
    else a.tickmode = "auto";
    return a;
  }

  // 1y / 5y / 10y / All buttons on a date axis.
  function rangeButtons(t) {
    return {
      x: 0, y: 1.0, yanchor: "bottom", xanchor: "left",
      bgcolor: t.paper, activecolor: t.line, bordercolor: t.line, borderwidth: 1,
      font: { family: t.mono, size: 10, color: t.inkSoft },
      buttons: [
        { count: 1, label: "1y", step: "year", stepmode: "backward" },
        { count: 5, label: "5y", step: "year", stepmode: "backward" },
        { count: 10, label: "10y", step: "year", stepmode: "backward" },
        { step: "all", label: "All" }
      ]
    };
  }

  // On a touch screen the toolbar never hides (there is no hover) and sits on
  // top of the 1y/5y/10y buttons, so it is only shown with a mouse.
  var CONFIG = {
    responsive: true, displaylogo: false, displayModeBar: coarse ? false : "hover",
    modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toggleSpikelines", "hoverClosestCartesian", "hoverCompareCartesian"],
    toImageButtonOptions: { format: "png", scale: 2 }
  };

  // spec = {
  //   height: px,
  //   build(theme) -> { data, layout }   pure; called again on a theme change
  //   group: link-group name or null      (x range shared within the group)
  //   key: stable name ("explorer-perf"); a rerender reuses the plot with
  //        the same key via Plotly.react instead of drawing it from scratch
  //   label: aria label for the slot
  //   legendScope: selector of the ancestor holding its [data-trace] legend
  //                entries (default ".panel")
  //   onClick(point): called with the clicked Plotly point (x, y, customdata)
  //   (a chart whose x axis isn't dates sets layout.xaxis.type itself)
  // }
  function slot(spec) {
    var id = "plot-" + (nextId++);
    pending[id] = spec;
    return '<div class="plot-slot" id="' + id + '" role="img" aria-label="' + String(spec.label || "chart").replace(/"/g, "&quot;")
      + '" style="min-height:' + spec.height + 'px"><div class="plot-msg">Loading chart&hellip;</div></div>';
  }

  // A group's key says what is on screen (asset, period). A new key drops the
  // remembered zoom — a range from the 1990s means nothing on another window.
  function linkKey(group, key) {
    var g = groups[group] || (groups[group] = { key: null, range: null });
    if (g.key !== key) { g.key = key; g.range = null; }
  }

  // The zoomed x range of a group as [fromDate, toDate] (YYYY-MM-DD), or null
  // when not zoomed — e.g. for an "use this range as the period" button.
  // onRange(group, fn) calls fn(range) after every zoom or reset in the group.
  var rangeListeners = {};
  function groupRange(group) {
    var g = groups[group];
    if (!g || !g.range) return null;
    return [String(g.range[0]).slice(0, 10), String(g.range[1]).slice(0, 10)];
  }
  function onRange(group, fn) { rangeListeners[group] = fn; }

  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }

  // Plots whose div has left the page, by spec.key. A fresh Plotly.newPlot
  // costs ~240 ms for the performance chart; Plotly.react on an existing plot
  // ~20 ms. So when the Explorer rebuilds its HTML, a detached plot with the
  // same key is moved into the new slot and updated in place instead.
  function takeDetached() {
    var spare = {};
    mounted = mounted.filter(function (m) {
      if (document.body.contains(m.div)) return true;
      if (m.spec.key && !spare[m.spec.key]) spare[m.spec.key] = m;
      else purge(m.div);
      return false;
    });
    return spare;
  }
  function purge(div) { try { window.Plotly.purge(div); } catch (e) { /* already gone */ } }
  function purgeDetached() { var spare = takeDetached(); Object.keys(spare).forEach(function (k) { purge(spare[k].div); }); }

  function figure(spec) {
    var t = theme();
    var f = spec.build(t);
    var layout = Object.assign(baseLayout(t, spec.height), f.layout || {});
    layout.xaxis = Object.assign(baseLayout(t, spec.height).xaxis, (f.layout || {}).xaxis || {});
    var g = spec.group && groups[spec.group];
    if (g && g.range) { layout.xaxis.range = g.range.slice(); layout.xaxis.autorange = false; }
    return { data: f.data, layout: layout };
  }

  function draw(div, spec) {
    var f = figure(spec);
    div.innerHTML = "";
    return window.Plotly.newPlot(div, f.data, f.layout, CONFIG).then(function () {
      if (spec.group) div.on("plotly_relayout", function (ev) { onZoom(div, ev); });
      // Read through _plotSpec so a reused plot calls its CURRENT spec's handler.
      div.on("plotly_click", function (ev) { var s = div._plotSpec; if (s && s.onClick && ev && ev.points && ev.points.length) s.onClick(ev.points[0]); });
      adopt(div, spec);
    });
  }

  // Reuse a detached plot for a new slot: same element, new figure.
  function redraw(old, slotEl, spec) {
    var div = old.div;
    div.id = slotEl.id;
    div.setAttribute("aria-label", slotEl.getAttribute("aria-label") || "");
    slotEl.parentNode.replaceChild(div, slotEl);
    var f = figure(spec);
    return window.Plotly.react(div, f.data, f.layout, CONFIG).then(function () { adopt(div, spec); });
  }

  function adopt(div, spec) {
    div._plotSpec = spec;   // the zoom handler reads the CURRENT spec's group
    mounted.push({ div: div, spec: spec });
    var scope = div.closest(spec.legendScope || ".panel");
    if (scope) wireLegend(scope, div);
  }

  // Zoom in one chart of a group -> same x range in the others (a double-click
  // reset propagates as autorange).
  function onZoom(src, ev) {
    var group = src._plotSpec && src._plotSpec.group;
    if (linking || !ev || !group) return;
    var range = null, reset = false;
    if (ev["xaxis.range[0]"] != null) range = [ev["xaxis.range[0]"], ev["xaxis.range[1]"]];
    else if (ev["xaxis.range"]) range = ev["xaxis.range"].slice();
    else if (ev["xaxis.autorange"]) reset = true;
    if (!range && !reset) return;
    groups[group].range = range;
    if (rangeListeners[group]) rangeListeners[group](groupRange(group));
    linking = true;
    var jobs = mounted.filter(function (m) { return m.spec.group === group && m.div !== src && document.body.contains(m.div); })
      .map(function (m) { return window.Plotly.relayout(m.div, reset ? { "xaxis.autorange": true } : { "xaxis.range": range.slice(), "xaxis.autorange": false }); });
    Promise.all(jobs).then(function () { linking = false; }, function () { linking = false; });
  }

  // Draws every pending slot under `root` that is in the page and visible, and
  // re-measures plots already drawn there: one drawn on a tab that was then
  // hidden keeps its old width through a window resize or phone rotation
  // (Plotly can't measure a display:none element), and so does one redrawn
  // for a light/dark switch while hidden.
  function mount(root) {
    root = root || document;
    if (loadState === "ready") {
      mounted.forEach(function (m) {
        if (root.contains(m.div) && visible(m.div)) { try { window.Plotly.Plots.resize(m.div); } catch (e) { /* purged */ } }
      });
    }
    Object.keys(pending).forEach(function (id) { if (!document.getElementById(id)) delete pending[id]; });
    var ids = Object.keys(pending).filter(function (id) {
      var el = document.getElementById(id);
      return el && root.contains(el) && visible(el);
    });
    if (!ids.length) return;
    load().then(function () {
      var spare = takeDetached();
      ids.forEach(function (id) {
        var el = document.getElementById(id), spec = pending[id];
        if (!el || !spec) return;              // replaced while Plotly was loading
        delete pending[id];
        var old = spec.key && spare[spec.key];
        if (old) delete spare[spec.key];
        (old ? redraw(old, el, spec) : draw(el, spec)).catch(function (e) {
          var target = document.getElementById(id) || el;
          target.innerHTML = '<div class="plot-msg">Couldn&#8217;t draw this chart: ' + String(e.message || e).replace(/</g, "&lt;") + '</div>';
        });
      });
      Object.keys(spare).forEach(function (k) { purge(spare[k].div); });
    }, function () {
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.innerHTML = '<div class="plot-msg">The interactive chart couldn&#8217;t load (Plotly from cdn.jsdelivr.net) &mdash; check your connection and reload.</div>';
      });
    });
  }

  // Legend entries in the page's own HTML legend toggle traces: an element with
  // data-trace="0,2" inside the slot's panel shows/hides those trace indexes.
  function wireLegend(panel, div) {
    panel.querySelectorAll("[data-trace]").forEach(function (el) {
      el.classList.add("lg-toggle");
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      function toggle() {
        var idx = el.getAttribute("data-trace").split(",").map(Number);
        var off = !el.classList.contains("lg-off");
        el.classList.toggle("lg-off", off);
        el.setAttribute("aria-pressed", off ? "false" : "true");
        window.Plotly.restyle(div, { visible: off ? "legendonly" : true }, idx);
      }
      el.addEventListener("click", toggle);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
  }

  // Indexes to keep when drawing n points as ~`target`: per bucket, the first
  // point plus the min and max of each series — so a crash's trough is never
  // skipped (a plain stride can, and then the drawn drawdown is shallower than
  // the "worst" label). `force` indexes (worst point, ruin) are always kept.
  function decimate(n, target, series, force) {
    if (n <= target) { var all = new Array(n); for (var a = 0; a < n; a++) all[a] = a; return all; }
    var bucket = Math.ceil(n / Math.max(1, Math.floor(target / (1 + 2 * series.length))));
    var keep = {};
    for (var s = 0; s < n; s += bucket) {
      var e = Math.min(n, s + bucket);
      keep[s] = 1;
      series.forEach(function (get) {
        var lo = s, hi = s, vlo = Infinity, vhi = -Infinity;
        for (var i = s; i < e; i++) {
          var v = get(i);
          if (v == null || !isFinite(v)) continue;
          if (v < vlo) { vlo = v; lo = i; }
          if (v > vhi) { vhi = v; hi = i; }
        }
        keep[lo] = 1; keep[hi] = 1;
      });
    }
    keep[n - 1] = 1;
    (force || []).forEach(function (i) { if (i >= 0 && i < n) keep[i] = 1; });
    return Object.keys(keep).map(Number).sort(function (x, y) { return x - y; });
  }

  // Exposure as a step area: only the points where the level changes, so a
  // century of daily positions is a few hundred points, exact at every edge.
  // levelAt(i) -> number; returns { x, y } for a 'hv' step trace.
  function steps(dates, levelAt, lo, hi) {
    var x = [], y = [], prev = null;
    for (var i = lo; i <= hi; i++) {
      var v = levelAt(i);
      if (v !== prev) { x.push(dates(i)); y.push(v); prev = v; }
    }
    x.push(dates(hi)); y.push(prev);
    return { x: x, y: y };
  }

  // Theme switch: redraw everything on screen with the new colours.
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onScheme = function () {
      if (loadState !== "ready") return;
      purgeDetached();
      mounted.forEach(function (m) { var f = figure(m.spec); window.Plotly.react(m.div, f.data, f.layout, CONFIG); });
    };
    if (mq.addEventListener) mq.addEventListener("change", onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }

  return {
    slot: slot, mount: mount, linkKey: linkKey, wireLegend: wireLegend,
    decimate: decimate, steps: steps, rangeButtons: rangeButtons, axisStyle: axisStyle, logAxis: logAxis,
    // For dev checks only: build every figure on screen without drawing it.
    groupRange: groupRange, onRange: onRange,
    _figures: function () { return mounted.map(function (m) { return figure(m.spec); }); },
    _pendingFigure: function (id) { return pending[id] ? figure(pending[id]) : null; }
  };
})();
