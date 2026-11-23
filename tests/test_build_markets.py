import json

import numpy as np
import pandas as pd
import pytest

import build_markets as bm


class TestR:
    @pytest.mark.parametrize("x", [None, float("nan"), np.nan, pd.NA])
    def test_missing_gives_none(self, x):
        assert bm.r(x) is None

    def test_rounds(self):
        assert bm.r(1.23456) == 1.23
        assert bm.r(1.23456, 3) == 1.235
        assert bm.r(np.float64(7)) == 7.0


class TestMarkets:
    def test_unrelated_commodity_ignored_and_ids_mapped(self, wfp_frame):
        extra = wfp_frame.assign(commodity="Rice (coarse)")
        out = bm.markets(pd.concat([wfp_frame, extra]))
        assert list(out) == ["green_chili"]

    def test_comilla_vs_dhaka_is_median_pct(self, wfp_frame):
        c = bm.markets(wfp_frame)["green_chili"]
        assert c["comilla_vs_dhaka_pct"] == -10.0
        assert c["overlap_months"] == 6
        assert c["points"] == dict(national=8, dhaka=6, comilla=8)

    def test_national_is_median_over_markets(self, wfp_frame):
        c = bm.markets(wfp_frame)["green_chili"]
        jan = next(m for m in c["months"] if m["month"] == "2025-01")
        # 20 fillers at 95, Dhaka 100, Comilla 90, Cheap 110, Thin 70 -> median 95
        assert jan["national"] == 95.0 and jan["n_markets"] == 24

    def test_egg_unit_multiplier_and_note(self, wfp_frame):
        eggs = wfp_frame.assign(commodity="Eggs (brown)")
        c = bm.markets(eggs)["egg_farm"]
        assert c["months"][0]["dhaka"] == 400.0          # per piece x 4 = per hali
        assert "হালি" in c["unit_note"]

    def test_commodity_with_too_few_points_is_skipped(self, wfp_frame):
        few = wfp_frame[wfp_frame.market.isin(["Dhaka Sadar", "Comilla Sadar"]) &
                        (wfp_frame.date < "2025-04-01")]
        assert bm.markets(few) == {}

    def test_districts_exclude_dhaka(self, wfp_frame):
        d = bm.markets(wfp_frame)["green_chili"]["districts"]
        assert "Dhaka Sadar" not in d
        assert "Comilla Sadar" in d

    def test_districts_min_points_filter(self, wfp_frame):
        d = bm.markets(wfp_frame)["green_chili"]["districts"]
        assert "Thin Town" not in d                      # only 3 months
        assert "Cheap Town" in d and len(d["Cheap Town"]["prices"]) == 8

    def test_vs_dhaka_sign(self, wfp_frame):
        d = bm.markets(wfp_frame)["green_chili"]["districts"]
        assert d["Cheap Town"]["vs_dhaka_pct"] == 10.0   # dearer than Dhaka -> positive
        assert d["Comilla Sadar"]["vs_dhaka_pct"] == -10.0  # cheaper -> negative
        assert d["Cheap Town"]["overlap_months"] == 6

    def test_vs_dhaka_none_when_overlap_short(self, wfp_frame):
        d = bm.markets(wfp_frame)["green_chili"]["districts"]["Late Town"]
        assert d["vs_dhaka_pct"] is None
        assert d["overlap_months"] == 4

    def test_ratio_quantiles_constant_ratio(self, wfp_frame):
        d = bm.markets(wfp_frame)["green_chili"]["districts"]
        assert d["Cheap Town"]["ratio"] == dict(p10=1.1, p50=1.1, p90=1.1)
        assert d["Comilla Sadar"]["ratio"] == dict(p10=0.9, p50=0.9, p90=0.9)

    def test_ratio_none_when_overlap_short(self, wfp_frame):
        d = bm.markets(wfp_frame)["green_chili"]["districts"]
        assert d["Late Town"]["ratio"] is None

    def test_district_record_shape(self, wfp_frame):
        d = bm.markets(wfp_frame)["green_chili"]["districts"]["Cheap Town"]
        assert d["name"] == "Cheap Town" and d["admin1"] == "Rajshahi"
        assert d["prices"]["2025-03"] == 110.0

    def test_output_is_json_serialisable(self, wfp_frame):
        json.dumps(bm.markets(wfp_frame))


class TestSpread:
    @pytest.fixture
    def agri(self, tmp_path, monkeypatch):
        n = 420
        dates = pd.date_range("2024-01-01", periods=n, freq="D")
        retail = np.full(n, 150.0)
        retail[-1] = 300.0                                # last-day spike
        df = pd.DataFrame({"date": dates,
                           "wholesale price minimum": 90.0, "wholesale price maximum": 110.0,
                           "retail price minimum": retail, "retail price maximum": retail})
        df.loc[5, "wholesale price minimum"] = 0          # outage row, must be dropped
        p = tmp_path / "agri.csv"
        df.to_csv(p, index=False)
        monkeypatch.setattr(bm, "AGRI", p)
        return df

    def test_ratio_flag_and_outage_row(self, agri):
        s = bm.spread()["green_chili"]
        assert s["days"] == len(agri) - 1
        assert s["typical_ratio"] == 1.5                  # 150 / 100
        assert s["latest"]["flag"] is True                # 3.0 > p90 of the previous year
        assert s["latest"]["ratio"] == 3.0
        assert s["flagged_days"] == 1
