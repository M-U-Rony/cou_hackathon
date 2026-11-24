"""Early Emerging Price Surge Detector (Challenge 1).

Flags an emerging upward price surge *before* the main CQR anomaly detector
confirms a Watch or Unusual deviation, using strictly causal (past & current)
signals and a Challenge 2 trust gate so missing/late/unit-suspect data cannot
trigger premature false alarms.

Two complementary pre-confirmation channels (firing only when status == Normal
and reporting trust is healthy):
  1. Pressure Buildup: price sits repeatedly in the upper half of the expected
     80% band (>=2 recent reports at score >= 0.50 across <=4d gaps) while rising
     versus 5 reports ago (dscore5 >= 0.15) and over 7 reports (ret7 > 0.5%).
  2. Velocity Shock: sharp short-horizon upward acceleration inside the band
     (score >= 0.45, ret3 >= max(8%, 2.5 * lagged vol_28), dscore3 >= 0.80,
     ret7 > 2%).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def band_pressure_score(y, mid, hi80) -> pd.Series:
    """Normalized log position inside/above the upper 80% expected band.

    0.0 = at model median (mid), 1.0 = at upper 80% edge (hi80).
    """
    y_arr = pd.Series(y, dtype=float)
    mid_arr = pd.Series(mid, index=y_arr.index, dtype=float)
    hi_arr = pd.Series(hi80, index=y_arr.index, dtype=float)
    denom = np.log(np.maximum(hi_arr / np.maximum(mid_arr, 1e-6), 1.0 + 1e-6))
    return np.log(np.maximum(y_arr, 1e-6) / np.maximum(mid_arr, 1e-6)) / denom


def gap_aware_streak(cond: pd.Series, dates=None, max_gap: int = 4) -> pd.Series:
    """Consecutive True run length, resetting whenever calendar gap > max_gap days."""
    s = pd.Series(cond, dtype=bool)
    if s.empty:
        return pd.Series(dtype=int, index=s.index)

    if dates is None and isinstance(s.index, pd.DatetimeIndex):
        dates = s.index

    if dates is not None:
        dt = pd.to_datetime(pd.Series(dates, index=s.index)).diff().dt.days.fillna(1).tolist()
    else:
        dt = [1] * len(s)

    runs: list[int] = []
    cur = 0
    for ok, g in zip(s.tolist(), dt):
        if not ok:
            cur = 0
        elif g > max_gap:
            cur = 1
        else:
            cur += 1
        runs.append(cur)
    return pd.Series(runs, index=s.index, dtype=int)


def _valid_span_mask(idx: pd.Index, steps: int, max_days: int) -> pd.Series:
    if isinstance(idx, pd.DatetimeIndex):
        s = pd.Series(idx, index=idx)
        return (s - s.shift(steps)).dt.days.fillna(max_days + 1) <= max_days
    return pd.Series(True, index=idx)


def detect_emerging_surge(res: pd.DataFrame) -> pd.DataFrame:
    """Compute pre-confirmation surge stage, score [0, 1], and reason cleanly."""
    out = res.copy()
    if out.empty:
        out["surge_stage"] = pd.Series(dtype="object")
        out["surge_score"] = pd.Series(dtype="float64")
        out["surge_reason"] = pd.Series(dtype="object")
        return out

    y = pd.to_numeric(out["y_price"], errors="coerce")
    mid = pd.to_numeric(out["model_mid"], errors="coerce")
    hi80 = pd.to_numeric(out["model_hi80"], errors="coerce")
    status = out.get("model_status", pd.Series("Normal", index=out.index)).astype(str)
    direction = out.get("model_dir", pd.Series("", index=out.index)).fillna("").astype(str)
    reason = out.get("model_reason", pd.Series("", index=out.index)).fillna("").astype(str)

    obs_gap = pd.to_numeric(out.get("obs_gap_days", pd.Series(1, index=out.index)), errors="coerce").fillna(1)
    trust = out.get("data_trust", pd.Series("high", index=out.index)).astype(str)
    unit_suspect = out.get("unit_suspect", pd.Series(False, index=out.index)).astype(bool)

    score = band_pressure_score(y, mid, hi80)
    log_y = np.log(np.maximum(y, 1e-6))

    span3_ok = _valid_span_mask(out.index, 3, 10)
    span5_ok = _valid_span_mask(out.index, 5, 14)
    span7_ok = _valid_span_mask(out.index, 7, 18)

    dscore3 = (score - score.shift(3)).where(span3_ok)
    dscore5 = (score - score.shift(5)).where(span5_ok)
    ret3 = (log_y - log_y.shift(3)).where(span3_ok)
    ret7 = (log_y - log_y.shift(7)).where(span7_ok)
    vol28 = log_y.diff().rolling(28, min_periods=5).std().shift(1).fillna(0.03)

    run_pressure = gap_aware_streak(score >= 0.50, dates=out.index, max_gap=4)

    trust_ok = (obs_gap <= 5) & (trust != "degraded") & (~unit_suspect)

    ch_pressure = (
        (run_pressure >= 2)
        & (score >= 0.50)
        & (dscore5 >= 0.15)
        & (ret7 > 0.005)
    )
    ch_velocity = (
        (score >= 0.45)
        & (ret3 >= np.maximum(0.08, 2.5 * vol28))
        & (dscore3 >= 0.80)
        & (ret7 > 0.02)
    )

    is_normal = status == "Normal"
    emerging = (ch_pressure | ch_velocity) & is_normal & trust_ok
    confirmed = ((status != "Normal") & (direction == "up")) | (reason == "steady_rise")

    surge_stage = np.where(confirmed, "confirmed", np.where(emerging, "emerging", "none"))
    surge_reason = np.where(
        confirmed,
        "confirmed_anomaly",
        np.where(emerging & ch_velocity & ~ch_pressure, "velocity_shock",
                 np.where(emerging, "pressure_buildup", "")),
    )

    p_comp = np.clip(score.fillna(0.0), 0.0, 1.2) / 1.2
    d_comp = np.clip(dscore5.fillna(0.0) / 0.50, 0.0, 1.0)
    m_comp = np.clip(ret7.fillna(0.0) / np.maximum(0.04, 2.0 * vol28), 0.0, 1.0)
    raw_score = 0.50 * p_comp + 0.25 * d_comp + 0.25 * m_comp

    suppressed = (score.fillna(0.0) <= 0) | (ret7.fillna(0.0) < 0) | (~trust_ok) | (direction == "down")
    adj_score = np.where(suppressed & (~confirmed), 0.0, raw_score)
    adj_score = np.where(emerging, np.maximum(adj_score, 0.60), adj_score)
    adj_score = np.where(confirmed, np.maximum(adj_score, 0.85), adj_score)

    out["surge_stage"] = surge_stage
    out["surge_score"] = np.round(np.clip(adj_score, 0.0, 1.0), 4)
    out["surge_reason"] = surge_reason
    return out
