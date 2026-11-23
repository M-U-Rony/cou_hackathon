import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "modeling") not in sys.path:
    sys.path.insert(0, str(ROOT / "modeling"))

from build_eval_summary import build_summary, write_summary


def _sample_dashboard_payload() -> dict:
    return {
        "generated": "2026-11-23",
        "horizon_days": 14,
        "metrics": [
            {
                "commodity": "egg_farm",
                "method": "model",
                "n_days": 1126,
                "coverage80": 0.821,
                "coverage95": 0.936,
                "median_width80_pct": 14.4,
                "unusual_per100_normal_days": 6.48,
            },
            {
                "commodity": "egg_farm",
                "method": "baseline",
                "n_days": 1126,
                "coverage80": 0.526,
                "coverage95": 0.719,
                "median_width80_pct": 11.8,
                "unusual_per100_normal_days": 25.81,
            },
        ],
        "commodities": {
            "egg_farm": {
                "latest": {"date": "2026-11-22", "price": 135.0, "status": "Normal"},
                "series": [{"date": "2026-11-21"}, {"date": "2026-11-22"}],
            }
        },
        "events": [
            {
                "event_id": "egg_oct_2024",
                "commodity": "egg_farm",
                "description": "Egg spike Oct 2024",
                "start": "2024-10-01",
                "peak": "2024-10-15",
                "end": "2024-10-30",
                "model": {
                    "detected": True,
                    "first_flag": "2024-10-01",
                    "first_unusual": None,
                    "lead_days_to_peak": 14,
                },
                "baseline": {
                    "detected": True,
                    "first_flag": "2024-09-07",
                    "first_unusual": "2024-09-17",
                    "lead_days_to_peak": 38,
                },
                "days": [{"date": "2024-10-01"}],
            }
        ],
        "fair_compare": {
            "summary": [
                {
                    "target_fa": 2,
                    "method": "model",
                    "actual_fa": 1.99,
                    "events": 7,
                    "detected": 4,
                    "median_lead": 16.0,
                    "mean_lead_detected": 19.0,
                },
                {
                    "target_fa": 2,
                    "method": "baseline",
                    "actual_fa": 1.99,
                    "events": 7,
                    "detected": 4,
                    "median_lead": 10.0,
                    "mean_lead_detected": 10.2,
                },
            ]
        },
    }


def test_build_summary_extracts_compact_metrics_and_events():
    summary = build_summary(_sample_dashboard_payload())

    assert summary["generated"] == "2026-11-23"
    assert summary["horizon_days"] == 14
    assert summary["validation"]["scheme"] == "walk-forward monthly expanding window (zero future leakage)"
    assert summary["commodities"]["egg_farm"]["latest_date"] == "2026-11-22"
    assert summary["commodities"]["egg_farm"]["model"]["coverage80"] == 0.821
    assert summary["commodities"]["egg_farm"]["baseline"]["unusual_per100_normal_days"] == 25.81
    assert summary["commodities"]["egg_farm"]["false_alarm_reduction_x"] == 3.98
    assert len(summary["events"]) == 1
    assert summary["events"][0]["event_id"] == "egg_oct_2024"
    assert summary["events"][0]["model_lead_days"] == 14
    assert "days" not in summary["events"][0]
    assert len(summary["equal_false_alarm_comparison"]) == 2


def test_write_summary_roundtrips_json(tmp_path: Path):
    src = tmp_path / "fairprice_data.json"
    dst = tmp_path / "evaluation_summary.json"
    src.write_text(json.dumps(_sample_dashboard_payload()), encoding="utf-8")

    out = write_summary(src, dst)
    loaded = json.loads(dst.read_text(encoding="utf-8"))

    assert out == loaded
    assert loaded["commodities"]["egg_farm"]["series_days"] == 2
