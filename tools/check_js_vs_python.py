"""Checks that the site's JS engine and strategy_lib.py agree, on real S&P history.

    python tools/check_js_vs_python.py

Needs Python (numpy), Node.js and internet access (downloads the S&P 500 history
from Yahoo Finance, ~24,800 daily closes back to 1927).

strategy_lib.py is written independently from the prospectus formula, so if the
two agree to the last digit on dozens of configurations, a bug would have to be
made twice in different languages. The JS side is the real site code
(js/cost-model.js + js/strategy-engine.js), run through tools/js_reference_runner.js.

Covers: fixed leverage 1x/2x/3x/5x with and without costs, and vol-gated 5x->3x and
3x->1x across vol windows 10/20/60 days, gates 15/22/30%, latched and unlatched.
"""
import datetime, json, os, subprocess, sys, tempfile, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)
import strategy_lib as sl


def sp500():
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=-1325635200&period2=1900000000&interval=1d"
    j = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=90).read())
    r = j["chart"]["result"][0]
    epoch = datetime.datetime(1970, 1, 1)
    return [((epoch + datetime.timedelta(seconds=t)).strftime("%Y-%m-%d"), c)
            for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]) if c]


def main():
    rows = sp500()
    dates, closes = [r[0] for r in rows], np.array([r[1] for r in rows])
    print(f"S&P 500: {len(rows)} rows, {dates[0]} -> {dates[-1]}")

    ca = json.load(open(os.path.join(ROOT, "cost-assumptions.json"), encoding="utf-8"))["SP500"]
    ref = os.path.join(ROOT, "reference-rates.json")
    fed, div = sl.load_reference_series(ref, "FEDFUNDS"), sl.load_reference_series(ref, "SPXDIV")
    products = [dict(leverage=p["leverage"], mgmt_fee_pct=p["mgmtFeePct"], daily_swap_rate_pct=p["dailySwapRatePct"],
                     funding_spread_pct=p["fundingSpreadPct"] + p["basisPct"]) for p in ca["products"]]
    SLIP = 25

    configs = []
    for lev in (1, 2, 3, 5):
        for costs in (False, True):
            configs.append(dict(sma=200, buffer=0.03, high=lev, gate=None, costs=costs))
    for vol_len in (10, 20, 60):
        for gate in (0.15, 0.22, 0.30):
            for high, low in ((5, 3), (3, 1)):
                for latch in (True, False):
                    configs.append(dict(sma=200, buffer=0.03, high=high, low=low, gate=gate, volLen=vol_len, latch=latch, costs=True))

    py = []
    for c in configs:
        kw = dict(products=products, rate_monthly=fed, dividend_monthly=div, slippage_bps_round_trip=SLIP) if c["costs"] else {}
        if c["gate"] is None:
            r = sl.run_backtest(dates, closes, c["sma"], c["buffer"], leverage_high=c["high"], **kw)
        else:
            r = sl.run_backtest(dates, closes, c["sma"], c["buffer"], vol_n=c["volLen"], vol_gate=c["gate"],
                                leverage_high=c["high"], leverage_low=c["low"], latch=c["latch"], **kw)
        py.append(float(r["equity"][-1]))

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(dict(prices=rows, configs=configs, slippageBps=SLIP), f)
        path = f.name
    try:
        out = subprocess.run(["node", os.path.join(HERE, "js_reference_runner.js"), path], capture_output=True, text=True, check=True)
    finally:
        os.unlink(path)
    js = [o["final"] for o in json.loads(out.stdout)]

    worst = 0.0
    for c, a, b in zip(configs, py, js):
        rel = abs(a - b) / max(abs(b), 1e-12)
        worst = max(worst, rel)
        if rel > 1e-9:
            print("MISMATCH", c, a, b)
    print(f"{len(configs)} configurations compared; worst relative difference between JS and Python: {worst:.2e}")
    print("PASS" if worst <= 1e-9 else "FAIL")
    sys.exit(0 if worst <= 1e-9 else 1)


if __name__ == "__main__":
    main()
