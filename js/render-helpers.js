// Shared card markup used by both the Home tab and the Developed Strategies
// tab, so both render a strategy's live status identically.
window.RenderHelpers = (function () {
  var fmt = window.App.fmt;

  function isVolTarget(strategy) {
    return (strategy.sizing || {}).mode === "volTarget";
  }

  // "In / long, 100%" for vol-targeted sizing, "In / long, 5x" for a
  // gated leverage ratchet, plain "In / long" for a 1x crossover.
  function stateLabel(strategy, status) {
    if (status.state === 0) return "Out / cash";
    if (isVolTarget(strategy)) return "In / long, " + Math.round(status.state * 100) + "%";
    if (strategy.leverage && strategy.leverage.gated != null) return "In / long, " + status.state + "x";
    return "In / long";
  }

  function subline(strategy) {
    var bits = [strategy.smaLen + "d SMA"];
    if (strategy.buffer) bits.push(fmt(strategy.buffer * 100, 0) + "% buffer");
    if (isVolTarget(strategy)) bits.push(fmt(strategy.sizing.volTarget * 100, 0) + "% vol target");
    else if (strategy.volGate != null) bits.push("vol gate");
    return bits.join(" &middot; ");
  }

  function renderStatusCard(strategy, status, extraHtml, opts) {
    opts = opts || {};
    var volTarget = isVolTarget(strategy);
    var hasGate = strategy.volGate != null;
    var showVol = status.vol !== null && status.vol !== undefined;
    var badgeClass = status.inPos ? "long" : "flat";

    var meterMin = strategy.meterRange.min, meterMax = strategy.meterRange.max;
    var zeroPct = (0 - meterMin) / (meterMax - meterMin) * 100;
    var fillPct = Math.max(0, Math.min(100, (status.ext - meterMin) / (meterMax - meterMin) * 100));
    var priceDecimals = strategy.liveAsset === "BTC" ? 0 : 2;

    var head = '<div class="card-head"><div><div class="name">' + strategy.name
      + (strategy.archived ? ' <span class="badge shelved">Shelved</span>' : '')
      + '</div><div class="sub">' + subline(strategy) + '</div></div>'
      + '<span class="badge ' + badgeClass + '">' + stateLabel(strategy, status) + '</span></div>';

    var html = '<div class="card' + (opts.clickable ? " card-click" : "") + (opts.selected ? " card-open" : "") + '"'
      + (opts.clickable ? ' role="button" tabindex="0" aria-expanded="' + (opts.selected ? "true" : "false") + '" data-strategy-id="' + strategy.id + '"' : "")
      + '>'
      + head
      + '<div class="statrow">'
      + '<div class="stat"><div class="k">Price</div><div class="v">$' + fmt(status.cur, priceDecimals) + '</div></div>'
      + '<div class="stat"><div class="k">' + strategy.smaLen + 'd SMA</div><div class="v">$' + fmt(status.sma, priceDecimals) + '</div></div>'
      + '</div>'
      + '<div class="meter-label"><span>Extension vs SMA</span><span class="num">' + (status.ext >= 0 ? "+" : "") + fmt(status.ext, 1) + '%</span></div>'
      + '<div class="meter"><div class="zero" style="left:' + zeroPct + '%"></div><div class="fill" style="left:' + Math.min(zeroPct, fillPct) + '%; width:' + Math.abs(fillPct - zeroPct) + '%;"></div><div class="mark" style="left:' + fillPct + '%"></div></div>';

    if (showVol) {
      var volMax = volTarget ? 120 : 26;
      var volFillPct = Math.max(0, Math.min(100, status.vol / volMax * 100));
      var volLabel = hasGate
        ? strategy.volLen + 'd realized vol vs ' + fmt(strategy.volGate * 100, 0) + '% gate'
        : strategy.volLen + 'd realized vol (annualised)';
      html += '<div class="meter-label"><span>' + volLabel + '</span><span class="num">' + fmt(status.vol, 1) + '%</span></div>'
        + '<div class="meter"><div class="fill" style="left:0%; width:' + volFillPct + '%;"></div>'
        + (hasGate ? '<div class="mark" style="left:' + ((strategy.volGate * 100) / volMax * 100) + '%; background:var(--warn);"></div>' : '')
        + '</div>';
    }

    if (volTarget) {
      var heldPct = Math.round(status.state * 100);
      var targetPct = Math.round(status.target * 100);
      html += '<div class="footline"><span class="k">Position</span><span class="v">' + heldPct + '%'
        + (targetPct !== heldPct ? ' <span class="muted">(target ' + targetPct + '%, inside band)</span>' : '')
        + '</span></div>';
      html += '<div class="tradehint' + (status.tradeDue ? " due" : "") + '">'
        + (status.tradeDue
          ? "Trade: move to " + heldPct + "% (was " + Math.round(status.prevState * 100) + "%)"
          : "No trade needed today")
        + '</div>';
    }

    html += '<div class="footline"><span class="k">Move to flip</span><span class="v">' + fmt(Math.abs(status.cushion), 1) + '%</span></div>';
    html += (extraHtml || "");
    html += '</div>';
    return html;
  }

  function renderCagrRow(cagrs) {
    function cell(label, val) {
      return '<div class="stat"><div class="k">' + label + '</div><div class="v">' + (val == null ? '&mdash;' : (val >= 0 ? '+' : '') + fmt(val, 1) + '%') + '</div></div>';
    }
    return '<div class="statrow cagr-row">'
      + cell('All-time', cagrs.allTime)
      + cell('10y', cagrs.y10)
      + cell('3y', cagrs.y3)
      + cell('1y', cagrs.y1)
      + '</div>';
  }

  // One-line teaser for the card; full table lives in the detail panel.
  function oddsOneLiner(odds) {
    var r = odds.nowRow;
    if (!r || !r.n) return '<div class="toolsrow">No comparable history at this distance from the SMA yet.</div>';
    var verb = odds.inPos ? "to next sell" : "of the asset to next buy";
    return '<div class="toolsrow">From here, typically ' + (r.typical >= 0 ? "+" : "") + fmt(r.typical, 1) + '% ' + verb
      + ' over ' + fmt(r.daysTypical, 0) + 'd (' + r.n + ' similar days, ' + r.episodes + ' episodes)</div>';
  }

  function renderOddsTable(odds) {
    var retHead = odds.inPos ? "Return to next sell" : "Asset move to next buy";
    var daysHead = odds.inPos ? "Days to sell" : "Days to buy";

    function row(r) {
      if (!r.n) {
        return '<tr class="thin"><td>' + r.label + '</td><td>0</td><td>0</td><td colspan="5">no comparable days</td></tr>';
      }
      // Thin evidence is about independent episodes, not raw day count.
      var cls = (r.isCurrent ? "cur" : "") + (r.episodes < 5 ? " thin" : "");
      return '<tr class="' + cls + '"><td>' + r.label + '</td>'
        + '<td>' + r.n + '</td>'
        + '<td>' + r.episodes + '</td>'
        + '<td>' + fmt(r.winPct, 0) + '%</td>'
        + '<td>' + (r.worst >= 0 ? "+" : "") + fmt(r.worst, 1) + '%</td>'
        + '<td>' + (r.typical >= 0 ? "+" : "") + fmt(r.typical, 1) + '%</td>'
        + '<td>' + (r.best >= 0 ? "+" : "") + fmt(r.best, 1) + '%</td>'
        + '<td>' + fmt(r.daysMin, 0) + ' / ' + fmt(r.daysTypical, 0) + ' / ' + fmt(r.daysMax, 0) + '</td></tr>';
    }

    return '<div class="panel">'
      + '<h2>Odds from here</h2>'
      + '<div class="oddswrap"><table class="hist odds">'
      + '<thead><tr><th>Distance from SMA</th><th>days</th><th>eps</th><th>% up</th>'
      + '<th colspan="3">' + retHead + ' (worst / typical / best)</th>'
      + '<th>' + daysHead + ' (min / typ / max)</th></tr></thead>'
      + '<tbody>' + row(odds.nowRow) + odds.rows.map(row).join("") + '</tbody>'
      + '</table></div>'
      + '<div class="toolsrow">'
      + (odds.inPos
        ? 'Strategy&#8217;s own compounded return from each historical day at that distance until the position closed. '
        : 'The underlying asset&#8217;s move while the strategy sat in cash &mdash; the strategy itself earns 0% flat. ')
      + 'Built from ' + odds.totalSamples + ' days across ' + odds.totalEpisodes + ' completed episodes; the current open episode is excluded because its outcome isn&#8217;t known yet. '
      + '<strong>&#8220;days&#8221; overstates the evidence</strong> &mdash; every day within one episode shares the same exit, so &#8220;eps&#8221; (independent episodes) is the number that matters. Rows backed by fewer than 5 episodes are dimmed.'
      + '</div>'
      + '</div>';
  }

  return {
    renderStatusCard: renderStatusCard,
    renderCagrRow: renderCagrRow,
    renderOddsTable: renderOddsTable,
    oddsOneLiner: oddsOneLiner,
    stateLabel: stateLabel
  };
})();
