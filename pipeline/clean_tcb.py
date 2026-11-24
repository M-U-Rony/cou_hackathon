"""Clean the raw TCB scrape (one row per sheet row) into a tidy daily price table.

Input : data/raw/tcb_prices_2021_2026.csv   (from Chrome scrape, all sheet rows, c0..c11)
Output: data/processed/tcb_all_long.csv     (every commodity: date, item, unit, min, max, mid)
        data/processed/tcb_core.csv         (core items only, one row per date x item)
        data/processed/tcb_qc.txt           (quality report)
"""
import re
import sys
import unicodedata
from pathlib import Path

import pandas as pd

_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from reporting_guard import sanitize_tcb_core  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/tcb_prices_2021_2026.csv"
OUT = ROOT / "data/processed"
OUT.mkdir(parents=True, exist_ok=True)

BN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s or "")
    s = s.replace("য়", "য়")  # য় -> য + nukta (one canonical form)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def num(s: str):
    s = norm(s).translate(BN_DIGITS)
    s = re.sub(r"[^\d.]", "", s)
    if not s or s == ".":
        return None
    try:
        return float(s)
    except ValueError:
        return None


# core commodity -> regex on normalized name (after removing spaces)
CORE = {
    "onion_local": r"^(?:পিঁ|পেঁ)য়াজ.*দেশী",
    "onion_import": r"^(?:পিঁ|পেঁ)য়াজ.*আম",
    "green_chili": r"^কাঁচামরিচ",
    "egg_farm": r"^ডিম\(ফার্ম\)",
    "potato": r"^আলু",
}
CORE = {k: re.compile(norm(v).replace(" ", "")) for k, v in CORE.items()}

STOP = re.compile(norm("যে সকল বাজার|মন্তব্য|যে সকল পণ্যের মূল্য"))


def main():
    df = pd.read_csv(RAW, dtype=str, keep_default_na=False)
    for c in ["c0", "c1", "c2", "c3"]:
        df[c] = df[c].map(norm)
    df["row_idx"] = df["row_idx"].astype(int)
    df = df.sort_values(["file_url", "row_idx"])

    # keep only the main table: rows before the first "markets surveyed / remarks" line
    stop_row = (
        df[df["c0"].str.contains(STOP) | df["c2"].str.contains(STOP)]
        .groupby("file_url")["row_idx"].min()
    )
    df = df.join(stop_row.rename("stop_at"), on="file_url")
    df = df[df["stop_at"].isna() | (df["row_idx"] < df["stop_at"])]

    # price rows = have a unit and a parseable today-min
    df["p_min"] = df["c2"].map(num)
    df["p_max"] = df["c3"].map(num)
    unit_ok = df["c1"].str.contains(norm("কেজি|হালি|লিটার|লিঃ|ডজন|পিস|দিস্তা|টন|গ্রাম|কৌটা|প্যাকেট"))
    px = df[unit_ok & df["p_min"].notna()].copy()
    px = px[px["report_date_iso"] != ""]

    px["item"] = px["c0"]
    px["key"] = px["item"].str.replace(" ", "", regex=False)
    # first occurrence per file+item (guards against repeated tables)
    px = px.drop_duplicates(["file_url", "key"], keep="first")

    px["date"] = pd.to_datetime(px["report_date_iso"], errors="coerce")
    px = px[px["date"].notna()]
    px["p_max"] = px["p_max"].fillna(px["p_min"])
    swap = px["p_min"] > px["p_max"]
    px.loc[swap, ["p_min", "p_max"]] = px.loc[swap, ["p_max", "p_min"]].values
    px["p_mid"] = (px["p_min"] + px["p_max"]) / 2

    long = px[["date", "item", "c1", "p_min", "p_max", "p_mid", "date_source", "file_url"]].rename(
        columns={"c1": "unit"}
    )
    long.sort_values(["date", "item"]).to_csv(OUT / "tcb_all_long.csv", index=False)

    # core items
    rows = []
    for code, rx in CORE.items():
        m = px[px["key"].str.contains(rx)].copy()
        m["commodity"] = code
        rows.append(m)
    core = pd.concat(rows)
    # if two files share a date, keep the one whose date came from the sub-header (most reliable)
    pri = {"subhdr": 0, "header": 1, "listing": 2}
    core["pri"] = core["date_source"].map(lambda s: min([v for k, v in pri.items() if k in str(s)] or [3]))
    core = core.sort_values(["commodity", "date", "pri"]).drop_duplicates(["commodity", "date"], keep="first")
    core = core[["date", "commodity", "item", "c1", "p_min", "p_max", "p_mid", "date_source", "file_url"]].rename(
        columns={"c1": "unit"}
    )
    core, audit = sanitize_tcb_core(core)
    core.to_csv(OUT / "tcb_core.csv", index=False)

    # QC report
    lines = [f"raw rows: {len(df)}  price rows (all items, deduped): {len(long)}",
             f"distinct dates: {long['date'].nunique()}  range: {long['date'].min().date()} .. {long['date'].max().date()}",
             f"distinct item names: {long['item'].nunique()}",
             f"unit/price guard: kept={audit['kept']} converted={audit['converted']} "
             f"dropped_invalid_price={audit['dropped_invalid_price']} dropped_incompatible_unit={audit['dropped_incompatible_unit']}",
             ""]
    for code, g in core.groupby("commodity"):
        g = g.sort_values("date")
        gaps = g["date"].diff().dt.days
        jumps = (g["p_mid"].pct_change().abs() > 0.5).sum()
        lines.append(
            f"{code:13s} n={len(g):5d} {g['date'].min().date()}..{g['date'].max().date()} "
            f"names={sorted(g['item'].unique())} units={sorted(g['unit'].unique())} "
            f"mid[min/med/max]={g['p_mid'].min():.0f}/{g['p_mid'].median():.0f}/{g['p_mid'].max():.0f} "
            f"maxgap={gaps.max():.0f}d gaps>7d={(gaps > 7).sum()} jumps>50%={jumps}"
        )
    (OUT / "tcb_qc.txt").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
