"""Build a compact, machine-readable evaluation summary from fairprice_data.json.

Committed to reports/evaluation_summary.json so reviewers and automated tools can
inspect calibrated coverage, false-alarm reduction, equal-FPR lead times, and
historical crisis replay outcomes without parsing the full dashboard bundle.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "dashboard" / "public" / "fairprice_data.json"
DEFAULT_OUTPUT = ROOT / "reports" / "evaluation_summary.json"


def build_summary(data: dict[str, Any]) -> dict[str, Any]:
    by_commodity: dict[str, dict[str, Any]] = {}
    for row in data.get("metrics", []):
        key = row["commodity"]
        method = row["method"]
        entry = by_commodity.setdefault(key, {})
        entry[method] = {
            "n_days": row["n_days"],
            "coverage80": row["coverage80"],
            "coverage95": row["coverage95"],
            "median_width80_pct": row["median_width80_pct"],
            "unusual_per100_normal_days": row["unusual_per100_normal_days"],
        }

    commodities_out: dict[str, Any] = {}
    for key, cdata in data.get("commodities", {}).items():
        latest = cdata.get("latest") or {}
        pair = by_commodity.get(key, {})
        model_m = pair.get("model")
        base_m = pair.get("baseline")
        reduction = None
        if model_m and base_m and model_m.get("unusual_per100_normal_days"):
            reduction = round(
                base_m["unusual_per100_normal_days"] / model_m["unusual_per100_normal_days"],
                2,
            )
        commodities_out[key] = {
            "latest_date": latest.get("date"),
            "latest_price": latest.get("price"),
            "latest_status": latest.get("status"),
            "series_days": len(cdata.get("series") or []),
            "model": model_m,
            "baseline": base_m,
            "false_alarm_reduction_x": reduction,
        }

    events_out = []
    for ev in data.get("events", []):
        m = ev.get("model") or {}
        b = ev.get("baseline") or {}
        item = {
            "event_id": ev["event_id"],
            "commodity": ev["commodity"],
            "description": ev.get("description"),
            "start": ev.get("start"),
            "peak": ev.get("peak"),
            "end": ev.get("end"),
            "model_detected": m.get("detected"),
            "model_first_flag": m.get("first_flag"),
            "model_lead_days": m.get("lead_days_to_peak"),
            "baseline_detected": b.get("detected"),
            "baseline_first_flag": b.get("first_flag"),
            "baseline_lead_days": b.get("lead_days_to_peak"),
        }
        if "first_emerging" in m:
            item["model_first_emerging"] = m.get("first_emerging")
            item["model_emerging_lead_days"] = m.get("emerging_lead_days_to_peak")
            item["days_before_confirmed"] = m.get("days_before_confirmed")
        events_out.append(item)

    out = {
        "project": "FairPrice BD",
        "generated": data.get("generated"),
        "horizon_days": data.get("horizon_days", 14),
        "validation": {
            "scheme": "walk-forward monthly expanding window (zero future leakage)",
            "calibration": "Conformalized Quantile Regression (CQR) on trailing 20% of each past training block",
            "baseline": "84-day rolling mean +/- standard deviation",
        },
        "commodities": commodities_out,
        "events": events_out,
        "equal_false_alarm_comparison": (data.get("fair_compare") or {}).get("summary", []),
    }
    if data.get("resilience"):
        out["early_surge_and_resilience"] = data["resilience"]
    return out


def write_summary(input_path: Path = DEFAULT_INPUT, output_path: Path = DEFAULT_OUTPUT) -> dict[str, Any]:
    raw = json.loads(input_path.read_text(encoding="utf-8"))
    summary = build_summary(raw)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Export compact evaluation_summary.json")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    write_summary(args.input, args.output)
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
