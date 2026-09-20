"""Re-tests the cost model against the REAL price history of leveraged products.

    python tools/check_leveraged_products.py

Needs numpy and internet access. Pulls daily prices from Yahoo Finance's public
chart endpoint and the Fed Funds rate from FRED, then asks: if the cost model's
formula (js/cost-model.js / strategy_lib.product_factor) were the whole story,
how far would its price path drift from the product's real one?

    drift = (real growth - model growth) per year, measured between the
            average of the first and last 20 trading days (so day-to-day
            timing noise doesn't accumulate). Positive = the real product did
            BETTER than the model; negative = the model is too generous.

The fee inputs are read from cost-assumptions.json, so what you audit there is
what gets tested here. Known limits (also stated in the site's cost panel):
  * London-listed products close ~11:30 ET, before the US close, so daily
    returns carry timing noise; levels over years do not.
  * Yahoo's 3USL series has an unadjusted 1-for-20 consolidation and a
    two-day bad print in 2017, spliced out by clean_series().
  * 5USL only has ~2.3 years of history, so its estimate is loose (~ +/-2%/yr).
"""
import csv, datetime, io, json, math, os, urllib.request, bisect
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "Mozilla/5.0"}
NICE = [1/100, 1/50, 1/20, 1/10, 1/5, 1/4, 1/2, 2, 4, 5, 10, 20, 50, 100]


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90).read().decode("utf-8", "ignore")


def yahoo(symbol, adjusted=False, start="2009-01-01"):
    p1 = int((datetime.datetime.fromisoformat(start) - datetime.datetime(1970, 1, 1)).total_seconds())
    j = json.loads(get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={p1}&period2=1900000000&interval=1d"))
    r = j["chart"]["result"][0]
    px = r["indicators"]["adjclose"][0]["adjclose"] if adjusted and "adjclose" in r["indicators"] else r["indicators"]["quote"][0]["close"]
    return {(datetime.datetime(1970, 1, 1) + datetime.timedelta(seconds=t)).strftime("%Y-%m-%d"): c
            for t, c in zip(r["timestamp"], px) if c}


def clean_series(series, drop=()):
    """Splice out share consolidations: a day-on-day ratio near 1/20, 1/10, ... (or 20, 10, ...).
    Genuine moves of a 3x-5x product (even -36% in a day) are far inside that range and are kept."""
    rows = [(d, c) for d, c in sorted(series.items()) if d not in drop]
    out, lvl = {rows[0][0]: 1.0}, 1.0
    for (_, ca), (db, cb) in zip(rows, rows[1:]):
        ratio = cb / ca
        if abs(math.log(ratio)) > 0.9:
            nearest = min(NICE, key=lambda n: abs(math.log(ratio / n)))
            if abs(math.log(ratio / nearest)) < 0.15:
                ratio /= nearest
        lvl *= ratio
        out[db] = lvl
    return out


def fed_funds():
    rows = list(csv.reader(io.StringIO(get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF"))))[1:]
    d = [r[0] for r in rows if r[1] not in ("", ".")]
    v = [float(r[1]) / 100 for r in rows if r[1] not in ("", ".")]
    return lambda date: v[max(bisect.bisect_right(d, date) - 1, 0)]


def days(a, b):
    return (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days


def model_path(dates, total_return, ffr, L, mgmt_pct, swap_pct_day, spread_pct):
    """The formula, applied day by day. total_return: {date: level} of a TOTAL return index."""
    nav, p = {dates[0]: 1.0}, 1.0
    for a, b in zip(dates, dates[1:]):
        D = days(a, b)
        r = total_return[b] / total_return[a] - 1
        R = L * r - (L - 1) * (ffr(a) + spread_pct / 100) * D / 360
        CA = mgmt_pct / 100 * D / 360 + swap_pct_day / 100 * D
        p *= (1 + R) * (1 - CA)
        nav[b] = p
    return nav


def drift_per_year(real, nav, dates, k=20):
    off = lambda ds: float(np.mean([math.log(real[d]) - math.log(nav[d]) for d in ds]))
    return (off(dates[-k:]) - off(dates[:k])) / (days(dates[k // 2], dates[-k // 2]) / 365.25)


def check(label, real, tr, ffr, L, mgmt, swap, spread):
    dates = sorted(d for d in real if d in tr)
    nav = model_path(dates, tr, ffr, L, mgmt, swap, spread)
    yrs = days(dates[0], dates[-1]) / 365.25
    g_real, g_model = real[dates[-1]] / real[dates[0]], nav[dates[-1]]
    print(f"{label:<58} {yrs:5.1f}y  real {g_real:8.2f}x  model {g_model:8.2f}x  drift {drift_per_year(real, nav, dates) * 100:+6.2f}%/yr")


if __name__ == "__main__":
    ca = json.load(open(os.path.join(HERE, "..", "cost-assumptions.json"), encoding="utf-8"))["SP500"]
    prod = {p["leverage"]: p for p in ca["products"]}
    print("Fetching prices (Yahoo) and Fed Funds (FRED)...")
    tr = yahoo("%5ESP500TR")
    ffr = fed_funds()
    print(f"\n{'check':<58} {'span':>6}  {'growth of $1':<28} drift (real - model)\n")

    p3 = prod[3]
    real3 = clean_series(yahoo("3USL.L", start="2012-12-01"), drop=("2017-06-26", "2017-06-27"))
    check("3USL vs S&P 500 TR, Final Terms fields", real3, tr, ffr, 3, p3["mgmtFeePct"], p3["dailySwapRatePct"], p3["fundingSpreadPct"])
    check("3USL, spread set to 0 (shows the spread matters)", real3, tr, ffr, 3, p3["mgmtFeePct"], p3["dailySwapRatePct"], 0.0)

    p5 = prod[5]
    real5 = clean_series(yahoo("5USL.L", start="2024-05-01"))
    check("5USL, Final Terms fields literally (spread N/A = 0)", real5, tr, ffr, 5, p5["mgmtFeePct"], p5["dailySwapRatePct"], p5["fundingSpreadPct"])
    check(f"5USL, plus the {p5['basisPct']}% basis allowance used on the site", real5, tr, ffr, 5, p5["mgmtFeePct"], p5["dailySwapRatePct"], p5["fundingSpreadPct"] + p5["basisPct"])
    check("5USL, fees only, no financing (shows financing matters)", real5, tr, lambda d: 0.0, 5, p5["mgmtFeePct"], p5["dailySwapRatePct"], 0.0)

    # US-listed funds close with the index, so no timing noise. Expense ratios are typed
    # here, NOT read from a source: treat these three lines as a sanity check on structure,
    # not on fees. (Direxion SPXL ~0.87%, ProShares UPRO ~0.91%, SSO ~0.89% — unverified.)
    for sym, L, er in (("SPXL", 3, 0.87), ("UPRO", 3, 0.91), ("SSO", 2, 0.89)):
        real = clean_series(yahoo(sym, adjusted=True))
        check(f"{sym} ({L}x, expense ratio {er}% assumed) vs S&P 500 TR, spread 0", real, tr, ffr, L, er, 0.0, 0.0)
    print("\nFor SPXL/UPRO/SSO a drift of about -1%/yr means ~0.6% per borrowed unit of financing above Fed Funds.")
