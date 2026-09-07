// Shared card markup used by both the Home tab and the Developed Strategies
// tab, so both render a strategy's live status identically.
window.RenderHelpers = (function () {
  var fmt = window.App.fmt;

  function renderStatusCard(strategy, status, extraHtml) {
    var hasVol = strategy.volGate != null;
    var badgeClass = status.inPos ? "long" : "flat";
    var badgeLabel = status.state === 0
      ? "Out / cash"
      : (strategy.leverage.gated != null ? ("In / long, " + status.state + "x") : "In / long");

    var subBits = [strategy.smaLen + "d SMA"];
    if (strategy.buffer) subBits.push(fmt(strategy.buffer * 100, 0) + "% buffer");
    if (hasVol) subBits.push("vol gate");

    var meterMin = strategy.meterRange.min, meterMax = strategy.meterRange.max;
    var zeroPct = (0 - meterMin) / (meterMax - meterMin) * 100;
    var fillPct = Math.max(0, Math.min(100, (status.ext - meterMin) / (meterMax - meterMin) * 100));
    var priceDecimals = strategy.liveAsset === "BTC" ? 0 : 2;

    var html = ""
      + '<div class="card">'
      + '<div class="card-head"><div><div class="name">' + strategy.name + '</div><div class="sub">' + subBits.join(" &middot; ") + '</div></div>'
      + '<span class="badge ' + badgeClass + '">' + badgeLabel + '</span></div>'
      + '<div class="statrow">'
      + '<div class="stat"><div class="k">Price</div><div class="v">$' + fmt(status.cur, priceDecimals) + '</div></div>'
      + '<div class="stat"><div class="k">' + strategy.smaLen + 'd SMA</div><div class="v">$' + fmt(status.sma, priceDecimals) + '</div></div>'
      + '</div>'
      + '<div class="meter-label"><span>Extension vs SMA</span><span class="num">' + (status.ext >= 0 ? "+" : "") + fmt(status.ext, 1) + '%</span></div>'
      + '<div class="meter"><div class="zero" style="left:' + zeroPct + '%"></div><div class="fill" style="left:' + Math.min(zeroPct, fillPct) + '%; width:' + Math.abs(fillPct - zeroPct) + '%;"></div><div class="mark" style="left:' + fillPct + '%"></div></div>';

    if (hasVol) {
      var volMax = 26;
      var volFillPct = Math.max(0, Math.min(100, (status.vol || 0) / volMax * 100));
      var volGatePct = (strategy.volGate * 100) / volMax * 100;
      html += '<div class="meter-label"><span>' + strategy.volLen + 'd realized vol vs ' + fmt(strategy.volGate * 100, 0) + '% gate</span><span class="num">' + (status.vol !== null ? fmt(status.vol, 1) + '%' : '&mdash;') + '</span></div>'
        + '<div class="meter"><div class="fill" style="left:0%; width:' + volFillPct + '%;"></div><div class="mark" style="left:' + volGatePct + '%; background:var(--warn);"></div></div>';
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

  return { renderStatusCard: renderStatusCard, renderCagrRow: renderCagrRow };
})();
