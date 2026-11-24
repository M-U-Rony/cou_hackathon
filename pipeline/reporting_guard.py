"""Reporting Hygiene & Resilience Guard (Challenge 2).

Protects anomaly detection when a market's weekly reporting is:
  1. Missing (7+ day reporting holes / sparse cadence)
  2. Late (stale reference anchor P_{t-H} or delayed arrival relative to market date)
  3. Inconsistent with usual units (explicit unit changes like Dozen/Piece/Palla/Maund
     OR unlabelled unit-scale glitches / invalid <=0 prices).

All functions here are strictly causal (using only current and past accepted prices)
and stack-neutral so both pipeline ingestion and walk-forward modeling share one contract.
"""
from __future__ import annotations

import re
import unicodedata
from collections import deque
from dataclasses import dataclass

import numpy as np
import pandas as pd

BN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


def _norm(s: str | None) -> str:
    s = unicodedata.normalize("NFC", s or "")
    s = s.replace("য়", "য়")
    return re.sub(r"\s+", " ", s).strip()


@dataclass(frozen=True)
class CanonicalSpec:
    unit: str
    dimension: str
    canonical_qty: float
    plausible_min: float
    plausible_max: float
    implicit_factors: tuple[float, ...]


CANONICAL_UNITS: dict[str, CanonicalSpec] = {
    "egg_farm": CanonicalSpec(
        unit=_norm("প্রতি হালি"),
        dimension="count",
        canonical_qty=4.0,
        plausible_min=15.0,
        plausible_max=140.0,
        implicit_factors=(3.0, 0.25, 25.0, 0.5),
    ),
    "potato": CanonicalSpec(
        unit=_norm("প্রতি কেজি"),
        dimension="mass",
        canonical_qty=1.0,
        plausible_min=8.0,
        plausible_max=180.0,
        implicit_factors=(5.0, 40.0, 100.0, 10.0, 0.25, 0.1),
    ),
    "onion_local": CanonicalSpec(
        unit=_norm("প্রতি কেজি"),
        dimension="mass",
        canonical_qty=1.0,
        plausible_min=12.0,
        plausible_max=350.0,
        implicit_factors=(5.0, 40.0, 100.0, 10.0, 0.25, 0.1),
    ),
    "onion_import": CanonicalSpec(
        unit=_norm("প্রতি কেজি"),
        dimension="mass",
        canonical_qty=1.0,
        plausible_min=12.0,
        plausible_max=350.0,
        implicit_factors=(5.0, 40.0, 100.0, 10.0, 0.25, 0.1),
    ),
    "green_chili": CanonicalSpec(
        unit=_norm("প্রতি কেজি"),
        dimension="mass",
        canonical_qty=1.0,
        plausible_min=15.0,
        plausible_max=800.0,
        implicit_factors=(5.0, 40.0, 100.0, 10.0, 0.25, 0.1),
    ),
}

# Ordered longest/most-specific first to avoid substring collisions.
_UNIT_TABLE: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"(?:কুইন্টাল|quintal)", re.I), "mass", 100.0),
    (re.compile(r"(?:মেট্রিক\s*টন|metric\s*ton|\bton\b|\bmt\b|টন)", re.I), "mass", 1000.0),
    (re.compile(r"(?:কিলোগ্রাম|kilogram|কেজি|কিলো|\bkg\b)", re.I), "mass", 1.0),
    (re.compile(r"(?:পাল্লা|palla)", re.I), "mass", 5.0),
    (re.compile(r"(?:মণ|মন|maund)", re.I), "mass", 40.0),
    (re.compile(r"(?:পোয়া|poa)", re.I), "mass", 0.25),
    (re.compile(r"(?:গ্রাম|গ্রাঃ|gram|\bgm\b|\bg\b)", re.I), "mass", 0.001),
    (re.compile(r"(?:মিলিলিটার|মিলি|\bml\b)", re.I), "volume", 0.001),
    (re.compile(r"(?:লিটার|লিঃ|lit(?:er|re)s?|\bl\b)", re.I), "volume", 1.0),
    (re.compile(r"(?:হালি|hali)", re.I), "count", 4.0),
    (re.compile(r"(?:ডজন|dozen|\bdoz\b)", re.I), "count", 12.0),
    (re.compile(r"(?:জোড়া|pair)", re.I), "count", 2.0),
    (re.compile(r"(?:পিস|পিচ|\bpieces?\b|\bpcs?\b|(?:^|[\s\d.-])(?:টি|টা)(?:$|\s))", re.I), "count", 1.0),
    (re.compile(r"(?:দিস্তা|কৌটা|প্যাকেট|packet|pack)", re.I), "other", 1.0),
]

_WORD_MULTS = (
    (re.compile(r"(?:আধা|অর্ধ|হাফ|\bhalf\b)"), 0.5),
    (re.compile(r"(?:পাঁচ)"), 5.0),
    (re.compile(r"(?:দশ)"), 10.0),
)


def parse_unit_spec(unit_str: str | None) -> tuple[str | None, float | None]:
    """Parse a Bengali/English retail unit string into (dimension, qty_in_base).

    Base units: 'count' -> pieces, 'mass' -> kg, 'volume' -> liter.
    """
    s = _norm(unit_str).translate(BN_DIGITS)
    if not s:
        return None, None
    # Strip parenthetical notes such as '(৪টি)' or '(12 pcs)' before parsing multiplier.
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"\s+", " ", s).strip()

    mult = 1.0
    m_num = re.search(r"(\d+(?:\.\d+)?)", s)
    if m_num:
        try:
            v = float(m_num.group(1))
            if v > 0:
                mult = v
        except ValueError:
            pass
    else:
        for rx, wmult in _WORD_MULTS:
            if rx.search(s):
                mult = wmult
                break

    for rx, dim, base_qty in _UNIT_TABLE:
        if rx.search(s):
            return dim, mult * base_qty

    if re.search(r"(?:শত|হান্ড্রেড|\bhundred\b)", s):
        return "count", mult * 100.0
    return None, None


def normalize_unit_price(
    commodity: str,
    unit_str: str | None,
    p_min: float | None,
    p_max: float | None = None,
) -> dict:
    """Validate prices and normalize explicit unit variations to commodity canonical units."""
    if p_min is None or pd.isna(p_min) or float(p_min) <= 0:
        return dict(
            valid=False,
            unit=_norm(unit_str),
            raw_unit=_norm(unit_str),
            p_min=None,
            p_max=None,
            p_mid=None,
            unit_status="invalid_price",
            unit_factor=np.nan,
        )

    lo = float(p_min)
    hi = lo if (p_max is None or pd.isna(p_max)) else float(p_max)
    if hi <= 0:
        return dict(
            valid=False,
            unit=_norm(unit_str),
            raw_unit=_norm(unit_str),
            p_min=None,
            p_max=None,
            p_mid=None,
            unit_status="invalid_price",
            unit_factor=np.nan,
        )
    if lo > hi:
        lo, hi = hi, lo

    raw_unit = _norm(unit_str)
    spec = CANONICAL_UNITS.get(commodity)
    if spec is None:
        return dict(
            valid=True,
            unit=raw_unit,
            raw_unit=raw_unit,
            p_min=lo,
            p_max=hi,
            p_mid=(lo + hi) / 2.0,
            unit_status="canonical",
            unit_factor=1.0,
        )

    dim, qty = parse_unit_spec(raw_unit)
    if dim is None or qty is None or qty <= 0 or dim != spec.dimension:
        return dict(
            valid=False,
            unit=spec.unit,
            raw_unit=raw_unit,
            p_min=None,
            p_max=None,
            p_mid=None,
            unit_status="incompatible",
            unit_factor=np.nan,
        )

    factor = qty / spec.canonical_qty
    if abs(factor - 1.0) <= 1e-6:
        status = "canonical"
        c_lo, c_hi = lo, hi
    else:
        status = "converted"
        c_lo, c_hi = round(lo / factor, 4), round(hi / factor, 4)

    return dict(
        valid=True,
        unit=spec.unit,
        raw_unit=raw_unit,
        p_min=c_lo,
        p_max=c_hi,
        p_mid=round((c_lo + c_hi) / 2.0, 4),
        unit_status=status,
        unit_factor=round(factor, 6),
    )


def sanitize_tcb_core(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Normalize units and quarantine <=0 or unit-incompatible rows in a TCB core table."""
    if df.empty:
        out = df.copy()
        for col in ("raw_unit", "unit_status", "unit_factor"):
            if col not in out.columns:
                out[col] = pd.Series(dtype="object" if col != "unit_factor" else "float64")
        return out, dict(kept=0, converted=0, dropped_invalid_price=0, dropped_incompatible_unit=0)

    kept_rows = []
    audit = dict(kept=0, converted=0, dropped_invalid_price=0, dropped_incompatible_unit=0)
    for row in df.to_dict("records"):
        res = normalize_unit_price(
            commodity=str(row.get("commodity", "")),
            unit_str=row.get("unit"),
            p_min=row.get("p_min"),
            p_max=row.get("p_max"),
        )
        if not res["valid"]:
            if res["unit_status"] == "invalid_price":
                audit["dropped_invalid_price"] += 1
            else:
                audit["dropped_incompatible_unit"] += 1
            continue
        row["unit"] = res["unit"]
        row["p_min"] = res["p_min"]
        row["p_max"] = res["p_max"]
        row["p_mid"] = res["p_mid"]
        row["raw_unit"] = row.get("raw_unit") or res["raw_unit"]
        if row.get("unit_status") == "converted" and res["unit_status"] == "canonical":
            # Preserve prior audit provenance if re-sanitized after normalization.
            row["unit_status"] = "converted"
            row["unit_factor"] = row.get("unit_factor", 1.0)
        else:
            row["unit_status"] = res["unit_status"]
            row["unit_factor"] = res["unit_factor"]
        if res["unit_status"] == "converted":
            audit["converted"] += 1
        audit["kept"] += 1
        kept_rows.append(row)

    out = pd.DataFrame(kept_rows)
    if out.empty:
        out = pd.DataFrame(columns=list(df.columns) + [c for c in ("raw_unit", "unit_status", "unit_factor") if c not in df.columns])
    return out, audit


def flag_implicit_unit_mismatches(
    s: pd.Series,
    commodity: str | None = None,
    window: int = 14,
    tol: float = 0.15,
) -> pd.DataFrame:
    """Strictly causal guard against unlabelled unit scale glitches or corrupted <=0 values.

    Maintains a rolling buffer of trailing *accepted* prices only, so a single week of
    mislabelled units (e.g. 3x Dozen reported as Hali) is quarantined without corrupting
    the trailing median or downstream P_{t-H} reference anchors.
    """
    s_sorted = s.sort_index()
    s_sorted = s_sorted[~s_sorted.index.duplicated()]
    spec = CANONICAL_UNITS.get(commodity or "")

    recent: deque[float] = deque(maxlen=window)
    clean_prices: list[float] = []
    suspects: list[bool] = []
    factors: list[float] = []
    statuses: list[str] = []

    for val in s_sorted.tolist():
        if val is None or pd.isna(val) or float(val) <= 0:
            clean_prices.append(np.nan)
            suspects.append(True)
            factors.append(np.nan)
            statuses.append("invalid_price")
            continue

        price = float(val)
        is_suspect = False
        est_factor = np.nan

        if spec is not None and (price < spec.plausible_min or price > spec.plausible_max):
            is_suspect = True
            if len(recent) >= 5:
                med = float(np.median(recent))
                ratio = price / med
                for f in spec.implicit_factors:
                    if abs(ratio / f - 1.0) <= tol:
                        est_factor = f
                        break

        if not is_suspect and len(recent) >= 5 and spec is not None:
            med = float(np.median(recent))
            ratio = price / med
            if abs(np.log(ratio)) >= 0.60:
                for f in spec.implicit_factors:
                    if abs(ratio / f - 1.0) <= tol:
                        is_suspect = True
                        est_factor = f
                        break

        if is_suspect:
            clean_prices.append(np.nan)
            suspects.append(True)
            factors.append(est_factor)
            statuses.append("suspect_unlabelled")
        else:
            recent.append(price)
            clean_prices.append(price)
            suspects.append(False)
            factors.append(1.0)
            statuses.append("ok")

    return pd.DataFrame(
        {
            "clean_price": clean_prices,
            "unit_suspect": suspects,
            "unit_factor_est": factors,
            "unit_status": statuses,
        },
        index=s_sorted.index,
    )


def staleness_band_scale(
    gap_days: pd.Series | np.ndarray | float,
    obs_gap_days: pd.Series | np.ndarray | float,
    horizon: int = 14,
    max_scale: float = 1.65,
) -> np.ndarray:
    """Diffusive log-band multiplier sqrt(effective_horizon / H) when reports are missing/late.

    Normal daily/weekend cadence (obs_gap_days <= 5 and ref gap_days - H < 4) keeps scale == 1.0
    exactly so calibrated CQR bands remain untouched in healthy reporting periods.
    """
    g = np.asarray(gap_days, dtype=float)
    og = np.asarray(obs_gap_days, dtype=float)
    extra_ref = np.maximum(0.0, g - float(horizon))
    extra_obs = np.maximum(0.0, og - 3.0)
    active = (extra_ref >= 4.0) | (og >= 6.0)
    eff_h = float(horizon) + extra_ref + 0.5 * extra_obs
    raw = np.sqrt(eff_h / float(horizon))
    scale = np.where(active, np.clip(raw, 1.0, max_scale), 1.0)
    return scale


def _factor_desc(f: float) -> str:
    if pd.isna(f):
        return ""
    if abs(f - 3.0) < 0.05:
        return "ডজন বনাম হালি (~৩ গুণ)"
    if abs(f - 0.25) < 0.02:
        return "পিস/পোয়া (~৪ ভাগ)"
    if abs(f - 5.0) < 0.1:
        return "পাল্লা/৫ কেজি (~৫ গুণ)"
    if abs(f - 40.0) < 0.5:
        return "মণ (~৪০ গুণ)"
    if abs(f - 100.0) < 1.0:
        return "কুইন্টাল (~১০০ গুণ)"
    return f"~{f:.2g} গুণ"


def assess_reporting_trust(res: pd.DataFrame, commodity: str | None = None) -> pd.DataFrame:
    """Evaluate data trustworthiness and prevent false anomaly spikes from missing/late/unit-bad data."""
    out = res.copy()
    n = len(out)
    obs_gap = pd.to_numeric(out.get("obs_gap_days", pd.Series(1, index=out.index)), errors="coerce").fillna(1)
    gap_days = pd.to_numeric(out.get("gap_days", pd.Series(14, index=out.index)), errors="coerce").fillna(14)
    band_inf = pd.to_numeric(out.get("band_inflation", pd.Series(1.0, index=out.index)), errors="coerce").fillna(1.0)
    rep_lag = pd.to_numeric(out.get("report_lag_days", pd.Series(0, index=out.index)), errors="coerce").fillna(0)
    unit_status = out.get("unit_status", pd.Series("canonical", index=out.index)).astype(str)
    unit_suspect = out.get("unit_suspect", pd.Series(False, index=out.index)).astype(bool)
    unit_factor_est = pd.to_numeric(out.get("unit_factor_est", pd.Series(np.nan, index=out.index)), errors="coerce")

    ref_stale = np.maximum(0.0, gap_days - 14.0)
    is_bad_unit = unit_suspect | unit_status.isin(["suspect_unlabelled", "incompatible", "invalid_price"])
    is_degraded = is_bad_unit | (obs_gap >= 14) | (ref_stale >= 10)
    is_caution = (~is_degraded) & (
        (obs_gap >= 6) | (ref_stale >= 4) | (unit_status == "converted") | (rep_lag >= 5) | (band_inf > 1.01)
    )

    trust = np.where(is_degraded, "degraded", np.where(is_caution, "caution", "high"))
    out["data_trust"] = trust
    out["signal_withheld"] = False

    # Enforce trust-preserving status rules
    if "model_status" in out.columns:
        bad_mask = is_bad_unit.to_numpy()
        if bad_mask.any():
            out.loc[bad_mask, "model_status"] = "Normal"
            out.loc[bad_mask, "model_dir"] = ""
            out.loc[bad_mask, "model_reason"] = "unit_suspect_withheld"
            out.loc[bad_mask, "signal_withheld"] = True

        # Isolated post-gap / severely delayed first report cannot immediately confirm "Unusual";
        # downgrade to Watch ("post_gap_caution") until corroborated by a follow-up observation.
        isolated_gap = ((obs_gap >= 7) | (rep_lag >= 5)) & (~is_bad_unit)
        cap_mask = (isolated_gap & (out["model_status"] == "Unusual")).to_numpy()
        if cap_mask.any():
            out.loc[cap_mask, "model_status"] = "Watch"
            out.loc[cap_mask, "model_reason"] = "post_gap_caution"

    notes: list[str] = []
    canonical_unit = CANONICAL_UNITS[commodity].unit if commodity in CANONICAL_UNITS else ""
    for i in range(n):
        tr = str(trust[i])
        if tr == "high":
            notes.append("")
            continue
        parts: list[str] = []
        if is_bad_unit.iloc[i]:
            f_txt = _factor_desc(float(unit_factor_est.iloc[i]))
            parts.append(
                f"ইউনিটে অসঙ্গতি সন্দেহ ({f_txt or 'অস্বাভাবিক স্কেল'}): ভুয়া অ্যালার্ম এড়াতে সংকেত স্থগিত রাখা হয়েছে"
            )
        elif unit_status.iloc[i] == "converted":
            parts.append(f"ভিন্ন একক থেকে '{canonical_unit}' এককে রূপান্তর করে হিসাব করা হয়েছে")
        if obs_gap.iloc[i] >= 6:
            parts.append(
                f"টানা {int(obs_gap.iloc[i])} দিন রিপোর্ট বন্ধ থাকার পর নতুন তথ্য এসেছে"
                + (f" — অনিশ্চয়তার সীমা {float(band_inf.iloc[i]):.2f}× বাড়ানো হয়েছে" if float(band_inf.iloc[i]) > 1.01 else "")
            )
        elif ref_stale.iloc[i] >= 4:
            parts.append(f"১৪ দিন আগের রেফারেন্স তথ্য {int(ref_stale.iloc[i])} দিন পুরনো হওয়ায় সীমা সামঞ্জস্য করা হয়েছে")
        if rep_lag.iloc[i] >= 5:
            parts.append(f"রিপোর্ট {int(rep_lag.iloc[i])} দিন দেরিতে আসায় সতর্ক পর্যবেক্ষণ চালু")
        notes.append("; ".join(parts) if parts else "তথ্যের ধারাবাহিকতায় সাময়িক সতর্কতা")

    out["trust_note_bn"] = notes
    return out
