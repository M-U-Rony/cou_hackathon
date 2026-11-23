import json

import numpy as np
import pandas as pd
import pytest

import export_dashboard as ed


def predictions(n=20):
    dates = pd.date_range("2024-01-01", periods=n)
    df = pd.DataFrame(dict(
        date=dates, commodity="potato", y_price=50.0 + np.arange(n),
        ref_price=49.0, model_mid=50.0, model_lo80=45.0, model_hi80=55.0,
        model_lo95=40.0, model_hi95=60.0, model_status="Normal", model_dir="",
        model_reason="", unexplained_pct=1.5, baseline_status="Normal",
        shap_bias=0.01, shap_ret_14_28=0.02))
    df.loc[n - 1, ["model_status", "model_dir"]] = ["Unusual", "up"]
    return df


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    model = tmp_path / "reports/model"
    model.mkdir(parents=True)
    predictions().to_csv(model / "potato_predictions.csv", index=False)
    pd.DataFrame([dict(commodity="potato", method="model", n_days=20, coverage80=0.8, coverage95=0.95,
                       median_width80_pct=np.nan, unusual_per100_normal_days=1.0)]).to_csv(model / "metrics.csv", index=False)
    pd.DataFrame([dict(event_id="p1", method="model", detected=True, first_flag="2024-01-05",
                       first_unusual=None, lead_days_to_peak=10)]).to_csv(model / "events_eval.csv", index=False)
    (tmp_path / "data").mkdir()
    pd.DataFrame([dict(event_id="p1", commodity="potato", start="2024-01-10", peak="2024-01-15",
                       end="2024-01-18", description="test event", source_note="x")]
                 ).to_csv(tmp_path / "data/events.csv", index=False)
    monkeypatch.setattr(ed, "ROOT", tmp_path)
    monkeypatch.setattr(ed, "MODEL", model)
    monkeypatch.setattr(ed, "OUT", tmp_path / "reports/dashboard")
    monkeypatch.setattr(ed, "EVENTS", tmp_path / "data/events.csv")
    return tmp_path


def run(ws):
    ed.main()
    return json.loads((ws / "reports/dashboard/fairprice_data.json").read_text(encoding="utf-8"))


class TestHelpers:
    def test_r2(self):
        assert ed.r2(1.2345) == 1.23
        assert ed.r2(np.nan) is None
        assert ed.r2(None) is None

    def test_day_record_basic_and_text(self):
        row = predictions().iloc[-1]
        d = ed.day_record(row, "potato", row.date, with_text=True)
        assert d["date"] == "2024-01-20" and d["price"] == 69.0
        assert d["status"] == "Unusual" and d["direction"] == "up"
        assert d["text_bn"].startswith("২০ জানুয়ারি ২০২৪")
        assert d["waterfall"][0]["key"] == "ref"

    def test_day_record_nan_becomes_none(self):
        row = predictions().iloc[0].copy()
        row["unexplained_pct"] = np.nan
        assert ed.day_record(row, "potato", row.date)["unexplained_pct"] is None


class TestMain:
    def test_without_fair_compare_is_null(self, workspace):
        data = run(workspace)
        assert data["fair_compare"] is None

    def test_with_fair_compare_has_summary_and_events(self, workspace):
        m = workspace / "reports/model"
        pd.DataFrame([dict(target_fa=5, method="model", threshold=1.0, actual_fa=4.0, events=2, detected=2,
                           median_lead=np.nan, mean_lead_detected=12.5)]).to_csv(m / "fair_compare.csv", index=False)
        pd.DataFrame([dict(target_fa=5, event_id="p1", baseline=np.nan, model=9.0)]).to_csv(
            m / "fair_compare_events.csv", index=False)
        fcmp = run(workspace)["fair_compare"]
        assert set(fcmp) == {"summary", "events"}
        assert fcmp["summary"][0]["median_lead"] is None          # NaN -> null, valid JSON
        assert fcmp["summary"][0]["mean_lead_detected"] == 12.5
        assert fcmp["events"][0]["baseline"] is None and fcmp["events"][0]["model"] == 9.0

    def test_fair_compare_summary_without_events_file(self, workspace):
        m = workspace / "reports/model"
        pd.DataFrame([dict(target_fa=5, method="model", threshold=1.0, actual_fa=4.0, events=2, detected=2,
                           median_lead=3.0, mean_lead_detected=3.0)]).to_csv(m / "fair_compare.csv", index=False)
        fcmp = run(workspace)["fair_compare"]
        assert len(fcmp["summary"]) == 1 and fcmp["events"] == []

    def test_commodities_events_and_metrics(self, workspace):
        data = run(workspace)
        assert list(data["commodities"]) == ["potato"]           # only commodities with predictions
        pot = data["commodities"]["potato"]
        assert pot["name_bn"] == "আলু" and len(pot["series"]) == 20
        assert pot["latest"]["status"] == "Unusual"
        assert data["metrics"][0]["median_width80_pct"] is None
        ev = data["events"][0]
        assert ev["event_id"] == "p1" and ev["model"]["lead_days_to_peak"] == 10
        assert ev["baseline"] is None                            # no baseline row in events_eval
        assert ev["days"][0]["date"] == "2024-01-01"             # starts <=45 days before event

    def test_markets_attached_when_present(self, workspace):
        (workspace / "data/processed").mkdir()
        (workspace / "data/processed/markets.json").write_text(
            json.dumps(dict(markets={"potato": {"districts": {}}}, spread={})), encoding="utf-8")
        data = run(workspace)
        assert data["markets"] == {"potato": {"districts": {}}}
        assert data["spread"] == {}

    def test_markets_absent_when_file_missing(self, workspace):
        assert "markets" not in run(workspace)

    def test_writes_charts(self, workspace):
        run(workspace)
        out = workspace / "reports/dashboard"
        assert (out / "waterfall_potato.png").exists() and (out / "replay_p1.png").exists()
