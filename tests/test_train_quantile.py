"""Only cheap, pure helpers of train_quantile: no model is trained here."""
import numpy as np
import pandas as pd
import pytest

import train_quantile as tq
from conftest import make_price_series


@pytest.fixture
def hermetic(tmp_path, monkeypatch):
    """No dollar/rain files; a small calendar with one Ramadan/Eid in 2024."""
    monkeypatch.setattr(tq, "FX_FILE", tmp_path / "no_fx.csv")
    monkeypatch.setattr(tq, "RAIN_FILE", tmp_path / "no_rain.csv")
    cal = tmp_path / "cal.csv"
    pd.DataFrame([dict(year=2024, ramadan_start="2024-03-11", eid_fitr="2024-04-10", eid_adha="2024-06-17")]
                 ).to_csv(cal, index=False)
    monkeypatch.setattr(tq, "CALENDAR", cal)


class TestCalendarFeatures:
    def test_days_and_ramadan_flag(self, hermetic):
        idx = pd.DatetimeIndex(["2024-03-01", "2024-03-11", "2024-04-09", "2024-04-10"])
        f = tq.calendar_features(idx)
        assert f.days_to_ramadan.tolist() == [10, 0, 60, 60]          # after start: next one unknown -> cap
        assert f.in_ramadan.tolist() == [0, 1, 1, 0]                   # [start, eid_fitr)
        assert f.days_to_fitr.iloc[0] == 40 and f.days_to_fitr.iloc[2] == 1

    def test_days_after_adha_capped_and_zero_before(self, hermetic):
        idx = pd.DatetimeIndex(["2024-06-01", "2024-06-17", "2024-06-20", "2024-09-01"])
        f = tq.calendar_features(idx)
        assert f.days_after_adha.tolist() == [30, 0, 3, 30]            # before first Eid -> cap

    def test_values_stay_within_caps(self, hermetic):
        f = tq.calendar_features(pd.date_range("2023-01-01", "2025-12-31"))
        assert f.days_to_ramadan.max() <= 60 and f.days_to_fitr.max() <= 45
        assert f.min().min() >= 0


class TestBuildFeatures:
    def test_columns_and_target_definition(self, hermetic, price_series):
        f = tq.build_features(price_series)
        for c in tq.BASE_FEATS + ["ref", "y_price", "target", "base_mid", "base_sd"]:
            assert c in f.columns
        np.testing.assert_allclose(f.target, np.log(f.y_price) - f.ref)

    def test_ref_is_price_h_days_earlier(self, hermetic, price_series):
        f = tq.build_features(price_series)
        t = f.index[100]
        assert f.loc[t, "ref"] == pytest.approx(np.log(price_series.loc[t - pd.Timedelta(days=tq.H)]))

    def test_no_lookahead(self, hermetic, price_series):
        """Changing the price on day D must not alter any feature before D + H."""
        D = price_series.index[300]
        bumped = price_series.copy()
        bumped.loc[D] *= 3
        a, b = tq.build_features(price_series), tq.build_features(bumped)
        feats = [c for c in a.columns if c not in ("y_price", "target")]
        before = a.index < D + pd.Timedelta(days=tq.H)
        pd.testing.assert_frame_equal(a.loc[before, feats], b.loc[before, feats])
        assert not a.loc[D + pd.Timedelta(days=tq.H), feats].equals(b.loc[D + pd.Timedelta(days=tq.H), feats])

    def test_duplicate_dates_and_unsorted_input_handled(self, hermetic, price_series):
        messy = pd.concat([price_series.iloc[::-1], price_series.iloc[:5]])
        pd.testing.assert_frame_equal(tq.build_features(messy), tq.build_features(price_series))

    def test_irregular_series_only_yields_observed_dates(self, hermetic, price_series):
        sparse = price_series.iloc[::3]
        f = tq.build_features(sparse)
        assert set(f.index) <= set(sparse.index)

    def test_gap_days_counts_since_last_observation(self, hermetic):
        s = make_price_series(120)
        s = s.drop(s.index[60:70])                      # 10-day hole
        f = tq.build_features(s)
        t = s.index[60]                                 # first observed day after the hole
        assert f.loc[t, "gap_days"] >= 10

    def test_baseline_band_uses_only_past(self, hermetic, price_series):
        f = tq.build_features(price_series)
        t = f.index[200]
        past = price_series.loc[t - pd.Timedelta(days=tq.H + 83): t - pd.Timedelta(days=tq.H)]
        assert f.loc[t, "base_mid"] == pytest.approx(past.mean())


class TestStatusRule:
    def test_flag_bands(self):
        y = pd.Series([50, 56, 63, 44, 38])
        st, dr = tq.flag(y, lo80=45, hi80=55, lo95=40, hi95=62)
        assert list(st) == ["Normal", "Watch", "Unusual", "Watch", "Unusual"]
        assert list(dr) == ["", "up", "up", "down", "down"]

    def test_edges_are_inside_band(self):
        st, dr = tq.flag(pd.Series([55.0, 45.0]), 45, 55, 40, 62)
        assert list(st) == ["Normal", "Normal"] and list(dr) == ["", ""]

    def test_steady_rise_needs_five_consecutive_days(self):
        mid, hi = pd.Series([50.0] * 8), pd.Series([60.0] * 8)
        y = pd.Series([50, 56, 56, 56, 56, 56, 50, 56.0])   # score = ln(1.12)/ln(1.2) = 0.62 > 0.6
        out = tq.steady_rise(y, mid, hi)
        assert out.tolist() == [False, False, False, False, False, True, False, False]

    def test_steady_rise_run_resets(self):
        mid, hi = pd.Series([50.0] * 10), pd.Series([60.0] * 10)
        y = pd.Series([56, 56, 56, 56, 50, 56, 56, 56, 56, 50.0])
        assert not tq.steady_rise(y, mid, hi).any()

    def test_steady_rise_below_threshold_never_fires(self):
        mid, hi = pd.Series([50.0] * 10), pd.Series([60.0] * 10)
        assert not tq.steady_rise(pd.Series([52.0] * 10), mid, hi).any()


class _Const:
    """Stand-in quantile model: predicts a fixed log-return."""
    def __init__(self, value):
        self.value = value

    def fit(self, X, y):
        return self

    def predict(self, X):
        return np.full(len(X), self.value)


class TestConformalAdjustment:
    @pytest.fixture
    def stub_models(self, monkeypatch):
        values = {0.025: -0.20, 0.10: -0.10, 0.50: 0.0, 0.90: 0.10, 0.975: 0.20}
        monkeypatch.setattr(tq, "make_model", lambda alpha: _Const(values[alpha]))
        monkeypatch.setattr(tq, "FEATS", ["a"])
        monkeypatch.setattr(tq, "HAVE_LGB", False)

    def train(self, targets):
        return pd.DataFrame(dict(a=0.0, target=targets, ref=np.log(50.0)))

    def test_no_adjustment_when_calibration_inside_bands(self, stub_models):
        _, adj = tq.fit_block(self.train(np.zeros(200)))
        assert adj["80"] <= 0 and adj["95"] <= 0      # errors are negative: bands are wide enough

    def test_adjustment_widens_when_calibration_misses(self, stub_models):
        # calibration slice (last 20% = 40 rows) sits at +0.30, above both hi bands
        targets = np.concatenate([np.zeros(160), np.full(40, 0.30)])
        _, adj = tq.fit_block(self.train(targets))
        assert adj["80"] == pytest.approx(0.30 - 0.10)
        assert adj["95"] == pytest.approx(0.30 - 0.20)

    def test_predict_block_applies_adjustment(self, stub_models):
        models = {k: _Const(v) for k, v in
                  dict(lo95=-0.2, lo80=-0.1, mid=0.0, hi80=0.1, hi95=0.2).items()}
        test = pd.DataFrame(dict(a=[0.0], ref=[np.log(50.0)]))
        p = tq.predict_block(models, {"80": 0.05, "95": 0.0}, test)
        assert p.mid.iloc[0] == pytest.approx(50.0)
        assert p.hi80.iloc[0] == pytest.approx(50 * np.exp(0.15))
        assert p.lo80.iloc[0] == pytest.approx(50 * np.exp(-0.15))
        assert p.hi95.iloc[0] == pytest.approx(50 * np.exp(0.2))

    def test_predict_block_bands_never_cross_mid(self, stub_models):
        models = {k: _Const(v) for k, v in
                  dict(lo95=0.3, lo80=0.2, mid=0.0, hi80=-0.2, hi95=-0.3).items()}   # crossed quantiles
        test = pd.DataFrame(dict(a=[0.0], ref=[np.log(50.0)]))
        p = tq.predict_block(models, {"80": 0.0, "95": 0.0}, test)
        assert p.lo80.iloc[0] <= p.mid.iloc[0] <= p.hi80.iloc[0]


class TestEvaluate:
    def test_coverage_false_alarms_and_lead(self):
        idx = pd.date_range("2024-01-01", periods=200)
        res = pd.DataFrame(index=idx)
        res["y_price"] = 50.0
        for m in ("model", "baseline"):
            res[f"{m}_lo80"], res[f"{m}_hi80"] = 45.0, 55.0
            res[f"{m}_lo95"], res[f"{m}_hi95"] = 40.0, 60.0
            res[f"{m}_status"], res[f"{m}_dir"] = "Normal", ""
        # model flags up 5 days before the peak, baseline never does
        peak = pd.Timestamp("2024-04-20")
        res.loc[peak - pd.Timedelta(days=5), ["model_status", "model_dir"]] = ["Unusual", "up"]
        ev = pd.DataFrame([dict(event_id="e", commodity="potato", start=pd.Timestamp("2024-04-10"),
                                peak=peak, end=pd.Timestamp("2024-04-30"))])
        rows, ev_rows = tq.evaluate(res, ev, "potato")
        model = next(r for r in rows if r["method"] == "model")
        assert model["coverage80"] == 1.0 and model["unusual_per100_normal_days"] == 0.0
        e_model = next(r for r in ev_rows if r["method"] == "model")
        e_base = next(r for r in ev_rows if r["method"] == "baseline")
        assert e_model["detected"] and e_model["lead_days_to_peak"] == 5
        assert not e_base["detected"] and e_base["lead_days_to_peak"] is None
