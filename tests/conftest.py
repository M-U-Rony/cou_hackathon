"""Shared setup: make pipeline/ and modeling/ importable and build tiny synthetic data."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "pipeline", ROOT / "modeling"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


@pytest.fixture
def wfp_frame():
    """WFP-style monthly retail prices for green chili, Jan-Aug 2025.

    - Dhaka Sadar: 100 each month; Comilla Sadar: 90 (10% cheaper)
    - 20 filler markets so every month counts as 'national' (>= 20 markets)
    - Cheap Town: 110 each month -> 10% above Dhaka
    - Thin Town: only 3 months -> below MIN_POINTS, must be dropped
    - Late Town: 6 months but only 4 overlap Dhaka -> kept, vs_dhaka_pct None
    """
    months = pd.date_range("2025-01-01", periods=8, freq="MS")
    rows = []

    def add(market, admin1, dates, price):
        for d in dates:
            rows.append(dict(date=d, admin1=admin1, market=market, commodity="Chili (green)",
                             unit="KG", price=price))

    add("Dhaka Sadar", "Dhaka", months[:6], 100.0)           # Dhaka only has Jan-Jun
    add("Comilla Sadar", "Chittagong", months, 90.0)
    add("Cheap Town", "Rajshahi", months, 110.0)
    add("Thin Town", "Khulna", months[:3], 70.0)
    add("Late Town", "Sylhet", months[2:], 80.0)             # Mar-Aug; overlap with Dhaka: Mar-Jun (4)
    for i in range(20):
        add(f"Filler {i}", "Barisal", months, 95.0)
    return pd.DataFrame(rows)


@pytest.fixture
def tcb_raw_rows():
    """Raw scrape rows as clean_tcb.main() expects them (all strings)."""
    def row(url, idx, c0, c1, c2, c3, date="2026-03-01", src="subhdr"):
        r = dict(file_url=url, row_idx=str(idx), report_date_iso=date, date_source=src)
        r.update({f"c{i}": "" for i in range(12)})
        r.update(c0=c0, c1=c1, c2=c2, c3=c3)
        return r
    return row


def make_price_series(n=500, start="2024-01-01", seed=0, base=50.0):
    idx = pd.date_range(start, periods=n, freq="D")
    rng = np.random.default_rng(seed)
    return pd.Series(base * np.exp(np.cumsum(rng.normal(0, 0.01, n))), index=idx)


@pytest.fixture
def price_series():
    return make_price_series()
