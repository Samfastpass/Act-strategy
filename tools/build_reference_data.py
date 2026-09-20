"""Rebuilds reference-rates.json — the monthly reference series the cost model needs.

    python tools/build_reference_data.py

Series (every figure is fetched from the named public source; nothing is typed in):
  FEDFUNDS  Effective Federal Funds Rate, % p.a.  — FRED series DFF (daily, 1954+)
  SONIA     Sterling Overnight Index Average, % p.a. — Bank of England IADB series IUDSOIA (daily, 1997+)
  SPXDIV    S&P 500 dividend yield, % p.a.  — multpl.com's monthly table (built from Robert Shiller's data, 1871+)

Daily series are averaged per calendar month; the site applies a month's value to every
day in it. That is coarse only around the day a rate changes, and immaterial for costs
that accrue as (rate x days/360).
"""
import csv, io, json, re, datetime, urllib.request, collections

UA = {"User-Agent": "Mozilla/5.0"}

def get(url, timeout=90):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")

def monthly_mean(pairs):
    by = collections.defaultdict(list)
    for d, v in pairs:
        by[d[:7]].append(v)
    return [[m, round(sum(v) / len(v), 4)] for m, v in sorted(by.items())]

def fedfunds():
    txt = get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF")
    rows = list(csv.reader(io.StringIO(txt)))[1:]
    return monthly_mean((r[0], float(r[1])) for r in rows if len(r) > 1 and r[1] not in ("", "."))

def sonia():
    url = ("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes"
           "&Datefrom=01/Jan/1997&Dateto=now&SeriesCodes=IUDSOIA&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N")
    rows = list(csv.reader(io.StringIO(get(url))))[1:]
    out = []
    for r in rows:
        if len(r) > 1 and r[1].strip():
            out.append((datetime.datetime.strptime(r[0].strip(), "%d %b %Y").strftime("%Y-%m-%d"), float(r[1])))
    return monthly_mean(out)

def spxdiv():
    h = get("https://www.multpl.com/s-p-500-dividend-yield/table/by-month")
    h = re.sub(r"&#x?\w+;", "", h)
    h = re.sub(r"<abbr[^>]*>.*?</abbr>", "", h, flags=re.S)
    rows = re.findall(r"<td>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*</td>\s*<td>\s*([\d.]+)%", h, flags=re.S)
    pairs = [(datetime.datetime.strptime(d, "%b %d, %Y").strftime("%Y-%m-%d"), float(v)) for d, v in rows]
    # the table's newest rows are month-end placeholders in the future; drop anything after today
    today = datetime.date.today().isoformat()
    return monthly_mean(p for p in sorted(pairs) if p[0] <= today)

if __name__ == "__main__":
    fetched = datetime.date.today().isoformat()
    out = {
        "_readme": "Monthly reference series for the cost model, built by tools/build_reference_data.py from the public sources below. Regenerate with that script; do not hand-edit. Each series is [ 'YYYY-MM', value ] pairs; the site applies a month's value to every day in it, and holds the first/last value outside the covered range.",
        "FEDFUNDS": {"label": "Effective Federal Funds Rate", "unit": "% p.a.", "fetched": fetched,
                     "source": "https://fred.stlouisfed.org/series/DFF", "method": "monthly mean of daily DFF",
                     "series": fedfunds()},
        "SONIA": {"label": "Sterling Overnight Index Average", "unit": "% p.a.", "fetched": fetched,
                  "source": "https://www.bankofengland.co.uk/boeapps/database/Rates.asp?TD=1&TM=Jan&TY=1997&into=GBP&rateview=D",
                  "method": "monthly mean of daily IUDSOIA", "series": sonia()},
        "SPXDIV": {"label": "S&P 500 dividend yield (trailing 12m dividends / price)", "unit": "% p.a.", "fetched": fetched,
                   "source": "https://www.multpl.com/s-p-500-dividend-yield/table/by-month",
                   "method": "multpl.com monthly table, itself built from Robert Shiller's S&P data (http://www.econ.yale.edu/~shiller/data.htm)",
                   "series": spxdiv()},
    }
    with open("reference-rates.json", "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    for k in ("FEDFUNDS", "SONIA", "SPXDIV"):
        s = out[k]["series"]
        print(f"{k}: {len(s)} months, {s[0][0]} -> {s[-1][0]}, latest {s[-1][1]}")
