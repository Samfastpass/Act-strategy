"""Rebuilds reference-rates.json — the monthly reference series the cost model needs.

    python tools/build_reference_data.py

Run monthly by .github/workflows/refresh-reference-rates.yml; safe to run by hand.

Series (every figure is fetched from the named public source; nothing is typed in):
  FEDFUNDS  Effective Federal Funds Rate, % p.a.  — FRED series DFF (daily, 1954+),
            falling back to the New York Fed's EFFR API for recent months when FRED
            is unreachable (it often times out)
  SONIA     Sterling Overnight Index Average, % p.a. — Bank of England IADB series IUDSOIA (daily, 1997+)
  SPXDIV    S&P 500 dividend yield, % p.a.  — multpl.com's monthly table (built from Robert Shiller's data, 1871+)

Daily series are averaged per calendar month; the site applies a month's value to every
day in it. That is coarse only around the day a rate changes, and immaterial for costs
that accrue as (rate x days/360). The current month is a partial average up to the last
observation, which is why this is re-run monthly.

Each series is fetched independently. If a source fails, that series keeps its previous
data (and its old `fetched` / `lastObservation` dates, which the site checks for
staleness) and the others still update; the script exits non-zero so the failure shows.
"""
import csv, io, json, re, sys, datetime, urllib.request, collections

OUT = "reference-rates.json"
UA = {"User-Agent": "Mozilla/5.0"}


def get(url, timeout=90):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")


def monthly_mean(pairs):
    by = collections.defaultdict(list)
    for d, v in pairs:
        by[d[:7]].append(v)
    return [[m, round(sum(v) / len(v), 4)] for m, v in sorted(by.items())]


def carry_forward(pairs, until=None):
    """Business-day observations -> every calendar day, each day carrying the
    last published value. That is how FRED's DFF treats weekends and holidays,
    so monthly means built from either source are like for like."""
    pairs = sorted(pairs)
    out = []
    for (d, v), nxt in zip(pairs, pairs[1:] + [None]):
        day = datetime.date.fromisoformat(d)
        stop = datetime.date.fromisoformat(nxt[0]) if nxt else datetime.date.fromisoformat(until or d) + datetime.timedelta(days=1)
        while day < stop:
            out.append((day.isoformat(), v))
            day += datetime.timedelta(days=1)
    return out


# --- sources: each returns (daily_or_monthly_pairs, info) ---------------------

def fedfunds(previous):
    try:
        txt = get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF")
        rows = list(csv.reader(io.StringIO(txt)))[1:]
        daily = [(r[0], float(r[1])) for r in rows if len(r) > 1 and r[1] not in ("", ".")]
        return monthly_mean(daily), {"method": "monthly mean of daily DFF (FRED)", "lastObservation": daily[-1][0], "latestDaily": daily[-1][1]}
    except Exception as e:
        print(f"FEDFUNDS: FRED unavailable ({e}); falling back to the New York Fed", file=sys.stderr)
    # Fallback: keep the months already on file, re-fetch the last few from the
    # NY Fed (which administers the rate; DFF is the same EFFR, with weekends).
    if not previous:
        raise RuntimeError("FRED is down and there is no previous series to extend")
    start = (datetime.date.fromisoformat(previous[-1][0] + "-01") - datetime.timedelta(days=62)).replace(day=1)
    js = json.loads(get("https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json"
                        f"?startDate={start.isoformat()}&endDate={datetime.date.today().isoformat()}"))
    obs = [(r["effectiveDate"], float(r["percentRate"])) for r in js["refRates"]]
    if not obs:
        raise RuntimeError("NY Fed returned no EFFR observations")
    daily = carry_forward(obs, until=max(d for d, _ in obs))
    recent = monthly_mean(daily)
    first_new = start.strftime("%Y-%m")
    series = [m for m in previous if m[0] < first_new] + recent
    return series, {"method": f"monthly mean of daily DFF (FRED); months from {first_new} from the New York Fed's EFFR "
                              "(https://markets.newyorkfed.org/api/rates/unsecured/effr), weekends and holidays carrying the last rate as DFF does",
                    "lastObservation": max(obs)[0], "latestDaily": max(obs)[1]}


def sonia(previous):
    url = ("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes"
           "&Datefrom=01/Jan/1997&Dateto=now&SeriesCodes=IUDSOIA&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N")
    rows = list(csv.reader(io.StringIO(get(url))))[1:]
    daily = []
    for r in rows:
        if len(r) > 1 and r[1].strip():
            daily.append((datetime.datetime.strptime(r[0].strip(), "%d %b %Y").strftime("%Y-%m-%d"), float(r[1])))
    daily.sort()
    return monthly_mean(daily), {"method": "monthly mean of daily IUDSOIA", "lastObservation": daily[-1][0], "latestDaily": daily[-1][1]}


def spxdiv(previous):
    h = get("https://www.multpl.com/s-p-500-dividend-yield/table/by-month")
    h = re.sub(r"&#x?\w+;", "", h)
    h = re.sub(r"<abbr[^>]*>.*?</abbr>", "", h, flags=re.S)
    rows = re.findall(r"<td>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*</td>\s*<td>\s*([\d.]+)%", h, flags=re.S)
    pairs = [(datetime.datetime.strptime(d, "%b %d, %Y").strftime("%Y-%m-%d"), float(v)) for d, v in rows]
    # the table's newest rows are month-end placeholders in the future; drop anything after today
    today = datetime.date.today().isoformat()
    pairs = sorted(p for p in pairs if p[0] <= today)
    return monthly_mean(pairs), {"method": "multpl.com monthly table, itself built from Robert Shiller's S&P data (http://www.econ.yale.edu/~shiller/data.htm)",
                                 "lastObservation": pairs[-1][0], "latestDaily": pairs[-1][1]}


SERIES = {
    "FEDFUNDS": {"label": "Effective Federal Funds Rate", "unit": "% p.a.",
                 "source": "https://fred.stlouisfed.org/series/DFF", "fetch": fedfunds},
    "SONIA": {"label": "Sterling Overnight Index Average", "unit": "% p.a.",
              "source": "https://www.bankofengland.co.uk/boeapps/database/Rates.asp?TD=1&TM=Jan&TY=1997&into=GBP&rateview=D", "fetch": sonia},
    "SPXDIV": {"label": "S&P 500 dividend yield (trailing 12m dividends / price)", "unit": "% p.a.",
               "source": "https://www.multpl.com/s-p-500-dividend-yield/table/by-month", "fetch": spxdiv},
}


def sane(name, series, previous):
    """Refuse a fetch that would silently shrink or corrupt a series."""
    if not series:
        raise RuntimeError("empty series")
    if previous and len(series) < len(previous) - 1:
        raise RuntimeError(f"only {len(series)} months, previously {len(previous)}")
    for m, v in series:
        if not (-5 < v < 50):
            raise RuntimeError(f"implausible value {v} in {m}")


if __name__ == "__main__":
    try:
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}
    today = datetime.date.today().isoformat()
    out = {"_readme": "Monthly reference series for the cost model, built by tools/build_reference_data.py from the public sources below. "
                      "Regenerate with that script (run monthly by a GitHub Action); do not hand-edit. Each series is [ 'YYYY-MM', value ] pairs; "
                      "the site applies a month's value to every day in it, and holds the first/last value outside the covered range. "
                      "`lastObservation` is the date of the newest daily figure; the site warns when it is old."}
    failed = []
    for name, spec in SERIES.items():
        prev = (old.get(name) or {})
        try:
            series, info = spec["fetch"](prev.get("series"))
            sane(name, series, prev.get("series"))
            out[name] = {"label": spec["label"], "unit": spec["unit"], "fetched": today, "source": spec["source"],
                         "method": info["method"], "lastObservation": info["lastObservation"],
                         "latestDaily": info["latestDaily"], "series": series}
        except Exception as e:
            failed.append(name)
            print(f"{name}: FAILED ({e}) — keeping the previous series", file=sys.stderr)
            if not prev:
                sys.exit(f"{name}: no previous data to keep; aborting")
            out[name] = prev
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    for k in SERIES:
        s = out[k]["series"]
        print(f"{k}: {len(s)} months, {s[0][0]} -> {s[-1][0]}, latest month {s[-1][1]}, "
              f"last observation {out[k].get('lastObservation', '?')} = {out[k].get('latestDaily', '?')}"
              + ("   (NOT UPDATED)" if k in failed else ""))
    sys.exit(1 if failed else 0)
