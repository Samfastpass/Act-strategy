// Keeps SPX_MERGED in sync when new SPX or SPY rows are imported.
//
// SPX_MERGED (see PROJECT_NOTES.md) is real SPX where it exists, and real
// SPY converted to SPX-equivalent units elsewhere, calibrated via a linear
// regression fit over the real SPX/SPY overlap. This module recomputes
// that regression from whatever SPX/SPY data currently exists — it does
// not know the exact coefficients used to build the historical
// SPX_MERGED rows already in Supabase, so it's self-consistent for newly
// appended data but never rewrites existing rows.
window.MergeSeries = (function () {

  function fitRegression(pairs) {
    var n = pairs.length;
    var sumX = 0, sumY = 0;
    for (var i = 0; i < n; i++) { sumX += pairs[i].x; sumY += pairs[i].y; }
    var meanX = sumX / n, meanY = sumY / n;
    var num = 0, den = 0;
    for (var j = 0; j < n; j++) {
      num += (pairs[j].x - meanX) * (pairs[j].y - meanY);
      den += (pairs[j].x - meanX) * (pairs[j].x - meanX);
    }
    var slope = den === 0 ? 0 : num / den;
    var intercept = meanY - slope * meanX;
    return { slope: slope, intercept: intercept };
  }

  // asset: "SPX" or "SPY" (the asset that was just imported).
  // newRows: [{date, close}] just written for that asset.
  // allSpx/allSpy: full current price history for SPX / SPY, ascending.
  // Returns SPX_MERGED rows to upsert (may be empty).
  function deriveMergedRows(asset, newRows, allSpx, allSpy) {
    if (!newRows.length) return [];

    if (asset === "SPX") {
      // Real SPX rows pass straight through as SPX_MERGED, unconverted.
      return newRows.map(function (r) { return { asset: "SPX_MERGED", date: r.date, close: r.close }; });
    }

    if (asset === "SPY") {
      if (!allSpx.length) return [];
      var cutoff = allSpx[allSpx.length - 1].date;
      var spxByDate = {};
      allSpx.forEach(function (r) { spxByDate[r.date] = r.close; });
      var pairs = allSpy
        .filter(function (r) { return r.date <= cutoff && spxByDate[r.date] != null; })
        .map(function (r) { return { x: r.close, y: spxByDate[r.date] }; });
      if (pairs.length < 2) return [];
      var reg = fitRegression(pairs);
      return newRows
        .filter(function (r) { return r.date > cutoff; })
        .map(function (r) { return { asset: "SPX_MERGED", date: r.date, close: reg.slope * r.close + reg.intercept }; });
    }

    return [];
  }

  return { fitRegression: fitRegression, deriveMergedRows: deriveMergedRows };
})();
