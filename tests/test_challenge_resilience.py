"""End-to-end synthetic stress tests proving Hackathon Challenge 1 & Challenge 2."""
import numpy as np
import pandas as pd

import early_surge as es
import reporting_guard as rg
import train_quantile as tq


class TestChallenge1StressScenarios:
    def test_emerging_fires_strictly_before_watch_on_ramp_and_low_noise_rate(self):
        rng = np.random.default_rng(7)
        n = 160
        idx = pd.date_range("2025-01-01", periods=n, freq="D")
        mid = np.full(n, 50.0)
        hi80 = np.full(n, 55.0)
        lo80 = np.full(n, 45.0)
        lo95 = np.full(n, 40.0)
        hi95 = np.full(n, 60.0)
        # 120 stable noisy normal days, then a 14-day emerging ramp crossing lo->mid->hi80->hi95
        noise = 50.0 * np.exp(rng.normal(0.0, 0.015, 120))
        ramp = np.linspace(50.5, 62.0, 40)
        y = np.concatenate([noise, ramp])

        st, dr = tq.flag(pd.Series(y, index=idx), lo80, hi80, lo95, hi95)
        res = pd.DataFrame(
            dict(
                y_price=y,
                model_mid=mid,
                model_hi80=hi80,
                model_status=st,
                model_dir=dr,
                model_reason="",
                obs_gap_days=1,
                data_trust="high",
                unit_suspect=False,
            ),
            index=idx,
        )
        steady = tq.steady_rise(res.y_price, res.model_mid, res.model_hi80, dates=res.index) & (res.model_status == "Normal")
        res.loc[steady, "model_status"] = "Watch"
        res.loc[steady, "model_dir"] = "up"
        res = es.detect_emerging_surge(res)

        first_em = res[res["surge_stage"] == "emerging"].index.min()
        first_conf = res[(res["model_status"] != "Normal") & (res["model_dir"] == "up")].index.min()
        assert pd.notna(first_em) and pd.notna(first_conf)
        assert first_em < first_conf

        normal_em_rate = (res.iloc[:120]["surge_stage"] == "emerging").mean() * 100
        assert normal_em_rate < 4.0


class TestChallenge2StressScenarios:
    def test_missing_week_widens_band_breaks_streak_and_prevents_false_unusual(self):
        # Simulate 40 daily observations, then drop 8 consecutive days (week+ missing),
        # then a noisy post-gap uptick that would cross an unwidened 95% band.
        dates = list(pd.date_range("2025-01-01", periods=30, freq="D"))
        dates.extend(pd.date_range("2025-02-09", periods=10, freq="D"))  # 9-day gap after Jan 30
        idx = pd.DatetimeIndex(dates)
        n = len(idx)

        # Build gap features
        obs_gap = pd.Series(idx, index=idx).diff().dt.days.fillna(1).astype(int)
        gap_days = np.maximum(14, 13 + obs_gap)
        scale = rg.staleness_band_scale(gap_days, obs_gap, horizon=14)
        # Day right after 9-day gap has index 30
        assert scale[30] > 1.25

        # Unwidened band would be [45..55] (80%) and [42..58] (95%).
        # With widened scale on day 30, upper 95% stretches far enough to keep noise trustworthy,
        # AND even if price spikes unusually on single isolated post-gap day, assess_reporting_trust
        # caps it to Watch + caution note instead of full Unusual alarm.
        res = pd.DataFrame(
            dict(
                y_price=50.0,
                model_mid=50.0,
                model_hi80=55.0,
                obs_gap_days=obs_gap,
                gap_days=gap_days,
                band_inflation=scale,
                unit_status="canonical",
                unit_suspect=False,
                model_status="Normal",
                model_dir="",
                model_reason="",
            ),
            index=idx,
        )
        # Also verify steady_rise does NOT stitch days before the 9-day gap with days after it
        res.iloc[26:30, res.columns.get_loc("y_price")] = 53.5  # 4 days before gap
        res.iloc[30, res.columns.get_loc("y_price")] = 53.5     # 1 day after gap
        sr = tq.steady_rise(res.y_price, res.model_mid, res.model_hi80, dates=res.index)
        assert not sr.iloc[30]

        # Single extreme outlier right after gap is capped to Watch ("post_gap_caution")
        res.iloc[30, res.columns.get_loc("model_status")] = "Unusual"
        res.iloc[30, res.columns.get_loc("model_dir")] = "up"
        out = rg.assess_reporting_trust(res, commodity="potato")
        assert out.iloc[30]["data_trust"] == "caution"
        assert out.iloc[30]["model_status"] == "Watch"
        assert out.iloc[30]["model_reason"] == "post_gap_caution"
        assert "রিপোর্ট বন্ধ" in out.iloc[30]["trust_note_bn"]

    def test_late_report_downgrades_trust_and_caps_single_day_unusual(self):
        idx = pd.date_range("2025-03-01", periods=5, freq="D")
        res = pd.DataFrame(
            dict(
                obs_gap_days=1,
                gap_days=14,
                band_inflation=1.0,
                report_lag_days=[0, 0, 7, 7, 0],
                unit_status="canonical",
                unit_suspect=False,
                model_status=["Normal", "Normal", "Unusual", "Normal", "Normal"],
                model_dir=["", "", "up", "", ""],
                model_reason=["", "", "outside_range", "", ""],
            ),
            index=idx,
        )
        out = rg.assess_reporting_trust(res, commodity="onion_local")
        assert out.iloc[2]["data_trust"] == "caution"
        assert out.iloc[2]["model_status"] == "Watch"
        assert "দেরিতে" in out.iloc[2]["trust_note_bn"]

    def test_explicit_unit_switch_and_unlabelled_3x_corruption_produce_zero_false_alarms(self):
        # 1) Explicit switch: 1 full week reported as "প্রতি ডজন" (~144 Tk) instead of "প্রতি হালি" (48 Tk)
        dates = pd.date_range("2025-04-01", periods=28, freq="D")
        raw = []
        for i, d in enumerate(dates):
            if 18 <= i < 25:
                raw.append(dict(date=d, commodity="egg_farm", item="ডিম (ফার্ম)", unit="প্রতি ডজন", p_min=144.0, p_max=150.0, p_mid=147.0))
            else:
                raw.append(dict(date=d, commodity="egg_farm", item="ডিম (ফার্ম)", unit="প্রতি হালি", p_min=48.0, p_max=50.0, p_mid=49.0))
        sanitized, audit = rg.sanitize_tcb_core(pd.DataFrame(raw))
        assert audit["converted"] == 7 and audit["kept"] == 28
        assert (sanitized["p_mid"] == 49.0).all()

        # 2) Implicit/unlabelled corruption: reported label still says "প্রতি হালি", price jumps 3x (147 Tk)
        s = pd.Series([49.0] * 18 + [147.0] * 5 + [49.0] * 5, index=dates)
        ucheck = rg.flag_implicit_unit_mismatches(s, "egg_farm")
        assert ucheck.iloc[18:23]["unit_suspect"].all()
        assert not ucheck.iloc[23:]["unit_suspect"].any()

        # Trust assessment must withhold alarms on those suspect days
        res = ucheck.copy()
        res["y_price"] = s
        res["obs_gap_days"] = 1
        res["gap_days"] = 14
        res["band_inflation"] = 1.0
        res["model_status"] = np.where(res["unit_suspect"], "Unusual", "Normal")
        res["model_dir"] = np.where(res["unit_suspect"], "up", "")
        res["model_reason"] = np.where(res["unit_suspect"], "outside_range", "")
        trusted = rg.assess_reporting_trust(res, commodity="egg_farm")
        assert (trusted.loc[dates[18:23], "model_status"] == "Normal").all()
        assert (trusted.loc[dates[18:23], "data_trust"] == "degraded").all()
        assert trusted.loc[dates[18:23], "signal_withheld"].all()
