"""Green chili history before TCB lists it (TCB starts 2026-02-18).

Source: AgriPriceBD (Mendeley Data, CC BY 4.0, https://data.mendeley.com/datasets/bkmxnrn3hn),
daily retail min/max, 2020-07-22 to 2025-06-04. Zero prices (portal outages,
Jan 2024) are dropped.

Level alignment: against WFP's monthly Dhaka Sadar retail price (HDX), the
AgriPriceBD mid price runs at a median 0.69x (Sep 2024 - May 2025, 9 months)
and TCB at 0.88x (Feb - Jul 2026, 6 months). AgriPriceBD is scaled by
0.88 / 0.69 = 1.27 so both sources sit on the TCB level. The model works on
log returns, so this only matters for the year-on-year feature across the
splice. Jun 2025 - Feb 2026 has no data and stays missing.

Run from repo root: python pipeline/build_extra_history.py
Writes data/processed/extra_history.csv (date,commodity,p_mid,source)
"""
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SCALE = round(0.88 / 0.69, 3)

a = pd.read_csv(ROOT / "data/external/agripricebd/green_chilli.csv", parse_dates=["date"])
a["p_mid"] = (a["retail price minimum"] + a["retail price maximum"]) / 2 * SCALE
a = a[a["retail price minimum"] > 0]
out = a[["date"]].assign(commodity="green_chili", p_mid=a.p_mid.round(2),
                         source=f"AgriPriceBD retail mid x{SCALE}")
out.to_csv(ROOT / "data/processed/extra_history.csv", index=False)
print(len(out), "rows", out.date.min().date(), "to", out.date.max().date(), "scale", SCALE)
