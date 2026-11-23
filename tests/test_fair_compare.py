import numpy as np
import pandas as pd
import pytest

import fair_compare as fc


def ts(s):
    return pd.Timestamp(s)


@pytest.fixture
def events():
    return pd.DataFrame([dict(event_id="e1", commodity="potato", start=ts("2024-02-10"),
                              peak=ts("2024-02-20"), end=ts("2024-02-28"))])


def make_scores(model_hit_from, baseline_hit_from, n_false=2, hit_value=2.0):
    """Daily frame Jan 1 - Apr 30 2024. Scores are 0.1 except from `*_hit_from`
    until the peak, plus `n_false` isolated false-alarm days (score 3.0) in the
    normal period (after the event ended)."""
    dates = pd.date_range("2024-01-01", "2024-04-30")
    df = pd.DataFrame(dict(date=dates, commodity="potato", y_price=50.0,
                           score_model=0.1, score_baseline=0.1))
    peak = ts("2024-02-20")
    for col, start in (("score_model", model_hit_from), ("score_baseline", baseline_hit_from)):
        if start is not None:
            df.loc[(df.date >= ts(start)) & (df.date <= peak), col] = hit_value
    fa_days = pd.date_range("2024-03-10", periods=n_false, freq="7D")
    df.loc[df.date.isin(fa_days), ["score_model", "score_baseline"]] = 3.0
    in_ev = (df.date >= ts("2024-02-10") - pd.Timedelta(days=30)) & (df.date <= ts("2024-02-28"))
    df["normal"] = ~in_ev
    return df


class TestAtFa:
    def sw(self):
        return pd.DataFrame(dict(threshold=[0.5, 1.0, 1.5, 2.0], fa_per100=[12.0, 6.0, 2.0, 0.0]))

    def test_picks_lowest_threshold_within_target(self):
        assert fc.at_fa(self.sw(), 5).threshold == 1.5
        assert fc.at_fa(self.sw(), 10).threshold == 1.0
        assert fc.at_fa(self.sw(), 1).threshold == 2.0

    def test_boundary_is_inclusive(self):
        assert fc.at_fa(self.sw(), 6).threshold == 1.0

    def test_none_when_no_threshold_meets_target(self):
        sw = pd.DataFrame(dict(threshold=[0.5, 1.0], fa_per100=[12.0, 6.0]))
        assert fc.at_fa(sw, 1) is None

    def test_unsorted_input(self):
        sw = self.sw().iloc[::-1]
        assert fc.at_fa(sw, 5).threshold == 1.5


class TestSweep:
    def test_lead_days_is_peak_minus_first_alert(self, events):
        df = make_scores("2024-02-12", None)             # model alerts 8 days before peak
        sw, eids = fc.sweep(df, events, "model")
        assert eids == ["e1"]
        row = sw[sw.threshold == 1.0].iloc[0]
        assert row.e1 == 8

    def test_never_alerting_method_has_nan_lead(self, events):
        df = make_scores("2024-02-12", None)
        sw, _ = fc.sweep(df, events, "baseline")
        # baseline only exceeds 1.0 on false-alarm days, all after the peak window
        assert np.isnan(sw[sw.threshold == 1.0].iloc[0].e1)

    def test_lead_shrinks_as_threshold_rises_past_score(self, events):
        df = make_scores("2024-02-12", None)
        sw, _ = fc.sweep(df, events, "model")
        # hit value 2.0: detected at thresholds < 2.0, missed at >= 2.0
        assert not np.isnan(sw[sw.threshold == 1.98].iloc[0].e1)
        assert np.isnan(sw[sw.threshold == 2.0].iloc[0].e1)

    def test_false_alarm_rate_counts_only_normal_days(self, events):
        df = make_scores("2024-02-12", "2024-02-12", n_false=2)
        sw, _ = fc.sweep(df, events, "model")
        n_normal = int(df.normal.sum())
        low = sw[sw.threshold == 1.0].iloc[0].fa_per100     # event-window hits do not count
        assert low == pytest.approx(2 / n_normal * 100)
        assert sw[sw.threshold == 3.0].iloc[0].fa_per100 == 0   # 3.0 is not > 3.0

    def test_window_starts_30_days_before_event(self, events):
        df = make_scores(None, None)
        df.loc[df.date == ts("2024-01-05"), "score_model"] = 5.0   # before the window opens
        df.loc[df.date == ts("2024-01-15"), "score_model"] = 5.0   # inside (Jan 11 onwards)
        sw, _ = fc.sweep(df, events, "model")
        assert sw[sw.threshold == 1.0].iloc[0].e1 == (ts("2024-02-20") - ts("2024-01-15")).days


class TestLoad:
    @pytest.fixture
    def model_dir(self, tmp_path, monkeypatch, events):
        d = tmp_path / "model"
        d.mkdir()
        dates = pd.date_range("2024-01-01", periods=4)
        pd.DataFrame(dict(
            date=dates, commodity="potato",
            y_price=[50, 60, 55, 50],
            model_mid=[50, 50, 50, 50], model_hi80=[55, 55, 55, 50],   # last row: zero-width band
            baseline_lo80=[40, 40, 40, 40], baseline_hi80=[60, 60, 60, 40],  # last: zero half-width
        )).to_csv(d / "potato_predictions.csv", index=False)
        ev = tmp_path / "events.csv"
        events.to_csv(ev, index=False)
        monkeypatch.setattr(fc, "MODEL", d)
        monkeypatch.setattr(fc, "EVENTS", ev)
        return d

    def test_score_formulas(self, model_dir):
        df, _ = fc.load()
        # model: log(price/mid) / log(hi80/mid)
        assert df.score_model.iloc[0] == pytest.approx(0.0)
        assert df.score_model.iloc[1] == pytest.approx(np.log(60 / 50) / np.log(55 / 50))
        assert df.score_model.iloc[2] == pytest.approx(np.log(55 / 50) / np.log(55 / 50))  # = 1
        # baseline: (price - centre) / half-width ; centre 50, half 10
        assert df.score_baseline.iloc[1] == pytest.approx(1.0)
        assert df.score_baseline.iloc[0] == pytest.approx(0.0)

    def test_degenerate_band_gives_nan_not_inf(self, model_dir):
        df, _ = fc.load()
        assert np.isnan(df.score_model.iloc[3]) and np.isnan(df.score_baseline.iloc[3])

    def test_normal_flag_excludes_event_window(self, model_dir):
        df, _ = fc.load()
        # event starts 2024-02-10 -> window opens 2024-01-11, so Jan 1-4 are normal
        assert df.normal.all()

    def test_normal_flag_false_inside_window(self, model_dir, tmp_path, monkeypatch):
        ev = pd.DataFrame([dict(event_id="e1", commodity="potato", start=ts("2024-01-10"),
                                peak=ts("2024-01-12"), end=ts("2024-01-20"))])
        p = tmp_path / "ev2.csv"
        ev.to_csv(p, index=False)
        monkeypatch.setattr(fc, "EVENTS", p)
        df, _ = fc.load()
        assert not df.normal.any()          # window starts Dec 11 and covers Jan 1-4
