"""Unit tests for modeling/early_surge.py (Challenge 1)."""
import numpy as np
import pandas as pd
import pytest

import early_surge as es


def _base_df(n=40, start="2025-01-01"):
    idx = pd.date_range(start, periods=n, freq="D")
    return pd.DataFrame(
        dict(
            y_price=np.full(n, 50.0),
            model_mid=np.full(n, 50.0),
            model_hi80=np.full(n, 55.0),
            model_status="Normal",
            model_dir="",
            model_reason="",
            obs_gap_days=1,
            data_trust="high",
            unit_suspect=False,
        ),
        index=idx,
    )


class TestHelpers:
    def test_band_pressure_score(self):
        sc = es.band_pressure_score([50.0, 55.0, 60.5], [50.0, 50.0, 50.0], [55.0, 55.0, 55.0])
        assert sc.iloc[0] == pytest.approx(0.0)
        assert sc.iloc[1] == pytest.approx(1.0)
        assert sc.iloc[2] > 1.5

    def test_gap_aware_streak_resets_across_hole(self):
        idx = pd.DatetimeIndex(["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-12", "2025-01-13"])
        cond = pd.Series([True, True, True, True, True], index=idx)
        runs = es.gap_aware_streak(cond, dates=idx, max_gap=4)
        assert runs.tolist() == [1, 2, 3, 1, 2]


class TestDetectEmergingSurge:
    def test_pressure_buildup_triggers_before_confirmation(self):
        df = _base_df(30)
        # Gradual climb starting day 15: stays inside hi80=55.0 so model_status stays Normal,
        # reaches score ~0.62 -> triggers pressure_buildup on second day in upper half.
        for k in range(15, 22):
            df.iloc[k, df.columns.get_loc("y_price")] = 53.1  # score = ln(53.1/50)/ln(55/50) = 0.63
        df.iloc[20:22, df.columns.get_loc("model_status")] = "Watch"
        df.iloc[20:22, df.columns.get_loc("model_dir")] = "up"
        out = es.detect_emerging_surge(df)
        assert out.iloc[16]["surge_stage"] == "emerging"
        assert out.iloc[16]["surge_reason"] == "pressure_buildup"
        assert out.iloc[16]["surge_score"] >= 0.60
        assert out.iloc[20]["surge_stage"] == "confirmed"

    def test_velocity_shock_triggers_on_sharp_jump_inside_band(self):
        df = _base_df(35)
        df["model_hi80"] = 66.0  # wide volatile band (eg chili)
        # low historical vol -> sharp jump to 63.0 while still < hi80 (score ~0.83, dscore3 ~0.83)
        df.iloc[29:, df.columns.get_loc("y_price")] = 63.0
        out = es.detect_emerging_surge(df)
        assert out.iloc[29]["surge_stage"] == "emerging"
        assert out.iloc[29]["surge_reason"] == "velocity_shock"
        assert out.iloc[29]["surge_score"] >= 0.60

    def test_suppressed_on_degraded_or_post_gap_or_down_days(self):
        df = _base_df(25)
        for k in range(15, 20):
            df.iloc[k, df.columns.get_loc("y_price")] = 53.5
        df.iloc[17, df.columns.get_loc("data_trust")] = "degraded"
        df.iloc[18, df.columns.get_loc("obs_gap_days")] = 8
        out = es.detect_emerging_surge(df)
        assert out.iloc[16]["surge_stage"] == "emerging"
        assert out.iloc[17]["surge_stage"] == "none"
        assert out.iloc[18]["surge_stage"] == "none"

    def test_strictly_causal_no_lookahead(self):
        a = _base_df(30)
        b = a.copy()
        b.iloc[22:, b.columns.get_loc("y_price")] = 75.0
        oa = es.detect_emerging_surge(a)
        ob = es.detect_emerging_surge(b)
        pd.testing.assert_frame_equal(oa.iloc[:22], ob.iloc[:22])
