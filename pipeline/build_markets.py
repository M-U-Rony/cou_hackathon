"""Market comparison (F8) and wholesale-retail spread (F7).

F8, other markets: TCB covers Dhaka only. WFP (HDX, monthly retail) covers
~50-95 district markets, Comilla Sadar included, from Sep 2024. To compare
like with like, all three lines come from WFP: Dhaka Sadar, Comilla Sadar and
the median of all markets that month.

F7, spread: TCB is retail only. AgriPriceBD gives daily Dhaka wholesale AND
retail prices for green chili, Jul 2020 - Jun 2025. Retail / wholesale ratio
is flagged when above the 90th percentile of the previous 365 days.

Inputs:
  data/external/wfp_subset.csv            (made from the HDX file on first run)
  data/external/agripricebd/green_chilli.csv
Output:
  data/processed/markets.json
Run from repo root:  python pipeline/build_markets.py [path/to/wfp_food_prices_bgd.csv]
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SUBSET = ROOT / "data/external/wfp_subset.csv"
AGRI = ROOT / "data/external/agripricebd/green_chilli.csv"
OUT = ROOT / "data/processed/markets.json"

# WFP commodity -> our id, multiplier to our unit
WFP_MAP = {
    "Chili (green)": ("green_chili", 1.0),          # Tk/kg
    "Eggs (brown)": ("egg_farm", 4.0),              # Tk/piece -> Tk/hali
    "Onions (imported, China)": ("onion_import", 1.0),
    "Potatoes (Holland, white)": ("potato", 1.0),
}
MARKETS = {"Dhaka Sadar": "dhaka", "Comilla Sadar": "comilla"}
MIN_POINTS = 6


def wfp_subset():
    if SUBSET.exists():
        return pd.read_csv(SUBSET, parse_dates=["date"])
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not src or not src.exists():
        sys.exit("Give the HDX wfp_food_prices_bgd.csv path on first run")
    w = pd.read_csv(src, skiprows=[1], parse_dates=["date"])
    w = w[(w.date >= "2021-01-01") & (w.pricetype == "Retail") & w.commodity.isin(WFP_MAP)]
    w = w[["date", "admin1", "market", "commodity", "unit", "price"]]
    w.to_csv(SUBSET, index=False)
    return w


def markets(w):
    out = {}
    for name, (cid, mult) in WFP_MAP.items():
        d = w[w.commodity == name].assign(price=lambda x: x.price.astype(float) * mult)
        d["month"] = d.date.dt.strftime("%Y-%m")
        nat = d.groupby("month").agg(national=("price", "median"), n_markets=("market", "nunique"))
        nat = nat[nat.n_markets >= 20]          # months with only a handful of markets are not "national"
        tab = nat.copy()
        for m, key in MARKETS.items():
            tab = tab.join(d[d.market == m].groupby("month").price.mean().rename(key), how="outer")
        tab = tab.sort_index()
        have = {k: int(tab[k].notna().sum()) for k in ("national", "dhaka", "comilla")}
        if have["comilla"] < MIN_POINTS and have["dhaka"] < MIN_POINTS:
            continue
        both = tab.dropna(subset=["dhaka", "comilla"])
        districts = {}
        for mname, grp in d[d.market != "Dhaka Sadar"].groupby("market"):
            ms = grp.groupby("month").price.mean()
            if len(ms) < MIN_POINTS:
                continue
            ov = tab[["dhaka"]].join(ms.rename("m"), how="inner").dropna()
            vs_dhk = None if len(ov) < MIN_POINTS else round(float(((ov.m / ov.dhaka) - 1).median() * 100), 1)
            ratio = None
            if len(ov) >= MIN_POINTS:
                q = (ov.m / ov.dhaka).quantile([0.1, 0.5, 0.9])
                ratio = dict(p10=round(float(q[0.1]), 4), p50=round(float(q[0.5]), 4), p90=round(float(q[0.9]), 4))
            districts[mname] = dict(
                name=mname,
                admin1=str(grp.admin1.iloc[0]),
                vs_dhaka_pct=vs_dhk,
                overlap_months=len(ov),
                ratio=ratio,
                prices={k: r(v) for k, v in ms.sort_index().items() if r(v) is not None},
            )
        out[cid] = dict(
            source="WFP / HDX monthly retail prices",
            unit_note="টাকা/হালি (প্রতি পিস × ৪)" if cid == "egg_farm" else "টাকা/কেজি",
            months=[dict(month=i, national=r(v.national), dhaka=r(v.dhaka), comilla=r(v.comilla),
                         n_markets=None if pd.isna(v.n_markets) else int(v.n_markets))
                    for i, v in tab.iterrows()],
            points=have,
            comilla_vs_dhaka_pct=None if len(both) < MIN_POINTS else round(float(((both.comilla / both.dhaka) - 1).median() * 100), 1),
            overlap_months=len(both),
            districts=districts,
        )
    return out


def spread():
    a = pd.read_csv(AGRI, parse_dates=["date"])
    a = a[(a["wholesale price minimum"] > 0) & (a["retail price minimum"] > 0)].copy()
    a["wholesale"] = (a["wholesale price minimum"] + a["wholesale price maximum"]) / 2
    a["retail"] = (a["retail price minimum"] + a["retail price maximum"]) / 2
    a["ratio"] = a.retail / a.wholesale
    s = a.set_index("date").sort_index()
    roll = s.ratio.rolling("365D", min_periods=150)
    s["p10"] = roll.quantile(0.10).shift(1)
    s["p90"] = roll.quantile(0.90).shift(1)
    s["flag"] = s.ratio > s.p90
    m = s.resample("MS").agg(dict(ratio="median", p10="last", p90="last", flag="sum", retail="mean", wholesale="mean"))
    m = m.dropna(subset=["ratio"])
    last = s.dropna(subset=["p90"]).iloc[-1]
    return {"green_chili": dict(
        source="AgriPriceBD (DAM), ঢাকা, দৈনিক পাইকারি ও খুচরা",
        until=str(s.index.max().date()),
        typical_ratio=round(float(s.ratio.median()), 2),
        flagged_days=int(s.flag.sum()), days=int(len(s)),
        latest=dict(date=str(last.name.date()), ratio=r(last.ratio), p10=r(last.p10), p90=r(last.p90),
                    retail=r(last.retail), wholesale=r(last.wholesale), flag=bool(last.flag)),
        months=[dict(month=i.strftime("%Y-%m"), ratio=r(v.ratio, 3), p10=r(v.p10, 3), p90=r(v.p90, 3),
                     flagged_days=int(v.flag), retail=r(v.retail), wholesale=r(v.wholesale))
                for i, v in m.iterrows()])}


def r(x, nd=2):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) or pd.isna(x) else round(float(x), nd)


if __name__ == "__main__":
    w = wfp_subset()
    res = dict(markets=markets(w), spread=spread())
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1))
    for k, v in res["markets"].items():
        print(k, v["points"], "comilla vs dhaka %:", v["comilla_vs_dhaka_pct"], "overlap", v["overlap_months"])
    sp = res["spread"]["green_chili"]
    print("spread: typical", sp["typical_ratio"], "flagged", sp["flagged_days"], "/", sp["days"], "latest", sp["latest"])
