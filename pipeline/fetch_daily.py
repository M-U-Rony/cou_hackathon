"""FairPrice BD — automated daily data refresher.

Fetches only NEW dates after the latest rows already stored in:
  1. data/processed/tcb_core.csv    (TCB daily Dhaka retail XLSX from tcb.gov.bd)
  2. data/external/rain_daily.csv   (Open-Meteo archive API for 6 districts)
  3. data/external/bdt_usd.csv      (Bangladesh Bank USD weighted average rate)

Each source is independent and idempotent: if a government portal is
temporarily down or it is a weekend/holiday, the script logs a warning and
continues without corrupting existing data.

Run from repo root:
    python pipeline/fetch_daily.py
"""
from __future__ import annotations

import io
import re
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests
import urllib3
from bs4 import BeautifulSoup

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Reuse exact normalization, commodity regexes, and reporting hygiene guard
from clean_tcb import CORE, STOP, norm, num
from reporting_guard import normalize_unit_price, sanitize_tcb_core

ROOT = Path(__file__).resolve().parents[1]
TCB_CORE = ROOT / "data/processed/tcb_core.csv"
RAIN_CSV = ROOT / "data/external/rain_daily.csv"
FX_CSV = ROOT / "data/external/bdt_usd.csv"

HEADERS = {"User-Agent": "FairPriceBD-DailyBot/1.0 (+https://github.com)"}

TCB_LIST_URLS = [
    "https://tcb.gov.bd/pages/daily-rmps",
]

# Coordinates for the 6 producing/market districts in rain_daily.csv
DISTRICTS = {
    "dhaka": (23.8103, 90.4125),
    "pabna": (24.0064, 89.2372),
    "faridpur": (23.6070, 89.8429),
    "bogura": (24.8465, 89.3773),
    "rajshahi": (24.3745, 88.6042),
    "jessore": (23.1664, 89.2081),
}

BN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")
DATE_RE = re.compile(r"(\d{1,2})[./-](\d{1,2})[./-](20\d{2})")


def _parse_date_from_text(text: str) -> str | None:
    s = norm(text).translate(BN_DIGITS)
    m = DATE_RE.search(s)
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def _parse_tcb_xlsx(content: bytes, file_url: str, fallback_date: str | None) -> list[dict]:
    """Parse one TCB daily retail XLSX sheet into core commodity rows."""
    df = pd.read_excel(io.BytesIO(content), header=None, dtype=str).fillna("")
    if df.shape[1] < 4:
        return []

    # Try to extract the report date from top header rows first (most reliable)
    report_date = None
    date_source = "listing"
    for r_idx in range(min(8, len(df))):
        row_text = " ".join(str(x) for x in df.iloc[r_idx].tolist())
        found = _parse_date_from_text(row_text)
        if found:
            report_date = found
            date_source = "subhdr" if r_idx > 0 else "header"
            break
    if not report_date:
        report_date = fallback_date
    if not report_date:
        return []

    unit_rx = re.compile(norm("কেজি|হালি|লিটার|লিঃ|ডজন|পিস|দিস্তা|টন|গ্রাম|কৌটা|প্যাকেট"))
    seen: set[str] = set()
    rows: list[dict] = []

    for r_idx in range(len(df)):
        c0 = norm(str(df.iat[r_idx, 0]))
        c1 = norm(str(df.iat[r_idx, 1]))
        c2 = norm(str(df.iat[r_idx, 2]))
        c3 = norm(str(df.iat[r_idx, 3]))
        if STOP.search(c0) or STOP.search(c2):
            break
        p_min = num(c2)
        if p_min is None or not unit_rx.search(c1):
            continue
        p_max = num(c3)
        if p_max is None:
            p_max = p_min
        if p_min > p_max:
            p_min, p_max = p_max, p_min
        key = c0.replace(" ", "")
        if key in seen:
            continue
        seen.add(key)
        for code, rx in CORE.items():
            if rx.search(key):
                norm_px = normalize_unit_price(code, c1, p_min, p_max)
                if not norm_px["valid"]:
                    continue
                rows.append(
                    dict(
                        date=report_date,
                        commodity=code,
                        item=c0,
                        unit=norm_px["unit"],
                        p_min=norm_px["p_min"],
                        p_max=norm_px["p_max"],
                        p_mid=norm_px["p_mid"],
                        date_source=date_source,
                        file_url=file_url,
                        raw_unit=norm_px["raw_unit"],
                        unit_status=norm_px["unit_status"],
                        unit_factor=norm_px["unit_factor"],
                    )
                )
    return rows


def update_tcb(max_files: int = 10) -> int:
    """Scrape latest TCB XLSX links and append any unseen dates to tcb_core.csv."""
    existing = pd.read_csv(TCB_CORE)
    seen_urls = set(existing["file_url"].dropna().astype(str))
    html = None
    for url in TCB_LIST_URLS:
        try:
            r = requests.get(url, headers=HEADERS, timeout=25, verify=False)
            if r.ok and ".xlsx" in r.text.lower():
                html = r.text
                break
        except Exception as e:
            print(f"[tcb] {url} failed: {e}")

    if not html:
        print("[tcb] could not reach TCB listing page; keeping existing data")
        return 0

    soup = BeautifulSoup(html, "html.parser")
    links: list[tuple[str, str | None]] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href.lower().endswith(".xlsx"):
            continue
        if href.startswith("//"):
            href = "https:" + href
        elif href.startswith("/"):
            href = "https://tcb.gov.bd" + href
        if href in seen_urls:
            continue
        tr = a.find_parent("tr")
        row_text = tr.get_text(" ", strip=True) if tr else a.get_text(" ", strip=True)
        links.append((href, _parse_date_from_text(row_text)))
        if len(links) >= max_files:
            break

    new_rows: list[dict] = []
    for href, fallback_date in links:
        try:
            resp = requests.get(href, headers=HEADERS, timeout=30, verify=False)
            resp.raise_for_status()
            parsed = _parse_tcb_xlsx(resp.content, href, fallback_date)
            new_rows.extend(parsed)
        except Exception as e:
            print(f"[tcb] failed {href}: {e}")

    if not new_rows:
        print("[tcb] already up to date (0 new rows)")
        return 0

    combined = pd.concat([existing, pd.DataFrame(new_rows)], ignore_index=True)
    combined["date"] = pd.to_datetime(combined["date"]).dt.strftime("%Y-%m-%d")
    combined, audit = sanitize_tcb_core(combined)
    combined = (
        combined.sort_values(["commodity", "date"])
        .drop_duplicates(["commodity", "date"], keep="last")
    )
    added = len(combined) - len(existing)
    combined.to_csv(TCB_CORE, index=False)
    print(f"[tcb] added {added} new commodity-day rows (latest: {combined['date'].max()}, guard={audit})")
    return added


def update_rain() -> int:
    """Append recent daily precipitation from Open-Meteo archive API."""
    existing = pd.read_csv(RAIN_CSV)
    last_date = pd.to_datetime(existing["date"]).max().date()
    start = last_date + timedelta(days=1)
    end = date.today() - timedelta(days=1)
    if start > end:
        print("[rain] already up to date")
        return 0

    frames = []
    for loc, (lat, lon) in DISTRICTS.items():
        url = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={lat}&longitude={lon}"
            f"&start_date={start.isoformat()}&end_date={end.isoformat()}"
            "&daily=precipitation_sum&timezone=Asia%2FDhaka"
        )
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
            r.raise_for_status()
            daily = r.json().get("daily", {})
            dates = daily.get("time", [])
            vals = daily.get("precipitation_sum", [])
            for d, v in zip(dates, vals):
                if v is not None:
                    frames.append(dict(date=d, location=loc, precip_mm=round(float(v), 2)))
        except Exception as e:
            print(f"[rain] {loc} failed: {e}")

    if not frames:
        print("[rain] no new rainfall rows available yet")
        return 0

    combined = pd.concat([existing, pd.DataFrame(frames)], ignore_index=True)
    combined = combined.drop_duplicates(["date", "location"], keep="last").sort_values(["location", "date"])
    added = len(combined) - len(existing)
    combined.to_csv(RAIN_CSV, index=False)
    print(f"[rain] added {added} rows (latest: {combined['date'].max()})")
    return added


def update_fx() -> int:
    """Fetch latest BDT/USD weighted average rate from Bangladesh Bank."""
    existing = pd.read_csv(FX_CSV)
    last_date = pd.to_datetime(existing["date"]).max().date()
    if last_date >= date.today():
        print("[fx] already up to date")
        return 0

    url = "https://www.bb.org.bd/en/index.php/econdata/exchangerate"
    try:
        r = requests.get(url, headers=HEADERS, timeout=25, verify=False)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
    except Exception as e:
        print(f"[fx] Bangladesh Bank fetch failed: {e}")
        return 0

    new_rows = []
    for tbl in soup.find_all("table"):
        for tr in tbl.find_all("tr"):
            vals = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if len(vals) < 2:
                continue
            dt = next((_parse_date_from_text(v) for v in vals if _parse_date_from_text(v)), None)
            nums = [num(v) for v in vals if num(v) is not None and 80 <= num(v) <= 200]
            if dt and nums:
                new_rows.append(
                    dict(
                        date=dt,
                        bdt_per_usd=round(float(nums[-1]), 2),
                        source="BB WAR (bb.org.bd/en/index.php/econdata/exchangerate)",
                    )
                )
        if new_rows:
            break

    if not new_rows:
        print("[fx] no new FX rows parsed")
        return 0

    combined = pd.concat([existing, pd.DataFrame(new_rows)], ignore_index=True)
    combined = combined.drop_duplicates(["date"], keep="last").sort_values("date")
    added = len(combined) - len(existing)
    combined.to_csv(FX_CSV, index=False)
    print(f"[fx] added {added} rows (latest: {combined['date'].max()})")
    return added


def main():
    tcb_n = update_tcb()
    rain_n = update_rain()
    fx_n = update_fx()
    print(f"Summary: tcb=+{tcb_n}, rain=+{rain_n}, fx=+{fx_n}")


if __name__ == "__main__":
    main()
