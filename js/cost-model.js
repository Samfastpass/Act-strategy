// The cost model — deliberately tiny and standalone so it can be read (and
// checked against the legal documents) in one sitting. Everything the
// explorer charges for holding a leveraged product goes through
// CostModel.dailyGrowth (dailyFactor is the same number with its parts
// broken out); nothing else in the app computes a fee or a financing cost.
//
// It implements the WisdomTree pricing rule literally
// (Collateralised ETP Securities base prospectus, p.72 and p.199):
//
//     P(t) = P(t-1) x (1 + R(t)) x (1 - CA(t))
//     R(t)  = L x [ index return ] + FBA(t)            FBA = funding & borrowing adjustment
//     CA(t) = AnnualMgmtFee x D/360  +  DailySwapRate x D
//
// where D is the number of CALENDAR days since the previous valuation date
// (3 across a weekend, not 1 — costs accrue on the calendar, not per row).
//
// For the products this app models, FBA reduces to one line. The financing
// paid on the borrowed (L-1) units is (base rate + funding spread) x D/360:
//
//   3USL (Final Terms IE00B7Y34M31, index = S&P 500 Net Total Return):
//       Interest Rate = Fed Funds, Funding Spread = 1.245%, so FBA = -(L-1)(FFR + 1.245%) D/360
//   5USL (Final Terms XS2771643025, index = S&P 500 Futures EXCESS return):
//       Interest Rate = Stock Borrow Rate = Fed Funds, Funding Spread N/A. The excess-return
//       index has already netted one unit of Fed Funds, and the borrow leg adds one back,
//       leaving  5 x TotalReturn - 4 x FFR  = the same expression with spread 0.
//
// So one formula covers both, provided `underlyingReturn` is the underlying's
// TOTAL return (price + dividends) for that period.
//
// What this file does NOT do: slippage (a one-off cost when exposure changes,
// handled in StrategyEngine.compoundEquity) and ruin (the floor at zero,
// also there).
window.CostModel = (function () {
  // The one product formula. All percentages are annual/daily % as printed in
  // the Final Terms (0.75 means 0.75%, 0.00136 means 0.00136% per day).
  //
  //   exposure          L, the leverage multiple held over the period (>0)
  //   underlyingReturn  the underlying's TOTAL return over the period, as a fraction
  //   days              D, calendar days since the previous valuation date
  //   baseRatePct       the reference short rate that day (Fed Funds / SONIA), % p.a.
  //   product           { mgmtFeePct, dailySwapRatePct, fundingSpreadPct }
  //
  // Returns the growth factor for the period plus its parts, so the UI can
  // show exactly where the drag came from.
  // The growth factor alone, allocation-free — this is what the backtest loop
  // calls (a 98-year daily series is ~25,000 calls per curve, times a 7x7
  // matrix). dailyFactor below returns the same number plus its parts.
  function dailyGrowth(exposure, underlyingReturn, days, baseRatePct, product) {
    var p = product || {};
    var borrowed = exposure > 1 ? exposure - 1 : 0;
    var financing = borrowed * ((baseRatePct || 0) + (p.fundingSpreadPct || 0)) / 100 * days / 360;
    var R = exposure * underlyingReturn - financing;
    // CA is charged on the product's whole value. A sub-1x volatility-targeted
    // position only has `exposure` of capital in the product, so scale it.
    var CA = ((p.mgmtFeePct || 0) / 100 * days / 360 + (p.dailySwapRatePct || 0) / 100 * days) * (exposure < 1 ? exposure : 1);
    return (1 + R) * (1 - CA);
  }

  // Same number, with the parts, so the UI can show where the drag came from.
  function dailyFactor(exposure, underlyingReturn, days, baseRatePct, product) {
    var p = product || {};
    var borrowed = Math.max(0, exposure - 1);
    var financing = borrowed * ((baseRatePct || 0) + (p.fundingSpreadPct || 0)) / 100 * days / 360;
    var CA = ((p.mgmtFeePct || 0) / 100 * days / 360 + (p.dailySwapRatePct || 0) / 100 * days) * Math.min(exposure, 1);
    return { factor: dailyGrowth(exposure, underlyingReturn, days, baseRatePct, product), financing: financing, charges: CA,
             R: exposure * underlyingReturn - financing };
  }

  // The product held at a given exposure: the smallest listed leverage that is
  // at least the exposure (so 2x is held via the 3x product and 4x via the 5x
  // one — conservative, since no smaller product exists to hold it), or the
  // largest product if the exposure exceeds them all.
  function pickProduct(products, exposure) {
    if (!products || !products.length) return null;
    for (var i = 0; i < products.length; i++) {
      if (exposure <= products[i].leverage + 1e-9) return products[i];
    }
    return products[products.length - 1];
  }

  // Annualised drag of a product at a given leverage and base rate, for
  // display ("what does 5x cost me a year at today's rates?"). Not used in
  // any calculation — the daily loop is the source of truth.
  function annualDrag(exposure, baseRatePct, product) {
    var p = product || {};
    var charges = ((p.mgmtFeePct || 0) / 100 * 365 / 360 + (p.dailySwapRatePct || 0) / 100 * 365) * Math.min(exposure, 1);
    var financing = Math.max(0, exposure - 1) * ((baseRatePct || 0) + (p.fundingSpreadPct || 0)) / 100 * 365 / 360;
    return { chargesPct: charges * 100, financingPct: financing * 100, totalPct: (charges + financing) * 100 };
  }

  return { dailyGrowth: dailyGrowth, dailyFactor: dailyFactor, pickProduct: pickProduct, annualDrag: annualDrag };
})();
