"""Unit tests for pipeline/reporting_guard.py (Challenge 2)."""
import numpy as np
import pandas as pd
import pytest

import reporting_guard as rg


class TestUnitParsingAndNormalization:
    @pytest.mark.parametrize("raw,exp_dim,exp_qty", [
        ("প্রতি কেজি", "mass", 1.0),
        ("প্রতি হালি", "count", 4.0),
        ("প্রতি হালি (৪টি)", "count", 4.0),
        ("প্রতি ডজন", "count", 12.0),
        ("প্রতি পিস", "count", 1.0),
        ("১০০ পিস", "count", 100.0),
        ("প্রতি ৫ কেজি", "mass", 5.0),
        ("পাল্লা", "mass", 5.0),
        ("২৫০ গ্রাম", "mass", 0.25),
        ("পোয়া", "mass", 0.25),
        ("আধা কেজি", "mass", 0.5),
        ("প্রতি মণ", "mass", 40.0),
        ("কুইন্টাল", "mass", 100.0),
        ("প্রতি লিটার", "volume", 1.0),
    ])
    def test_parse_unit_spec(self, raw, exp_dim, exp_qty):
        dim, qty = rg.parse_unit_spec(raw)
        assert dim == exp_dim
        assert qty == pytest.approx(exp_qty)

    def test_egg_dozen_and_piece_convert_to_hali(self):
        doz = rg.normalize_unit_price("egg_farm", "প্রতি ডজন", 144.0, 150.0)
        assert doz["valid"] and doz["unit_status"] == "converted"
        assert doz["unit"] == "প্রতি হালি"
        assert doz["unit_factor"] == pytest.approx(3.0)
        assert doz["p_mid"] == pytest.approx(49.0)

        pcs = rg.normalize_unit_price("egg_farm", "প্রতি পিস", 12.0, 12.5)
        assert pcs["valid"] and pcs["unit_status"] == "converted"
        assert pcs["unit_factor"] == pytest.approx(0.25)
        assert pcs["p_mid"] == pytest.approx(49.0)

        shot = rg.normalize_unit_price("egg_farm", "১০০ পিস", 1100.0, 1200.0)
        assert shot["valid"] and shot["unit_status"] == "converted"
        assert shot["unit_factor"] == pytest.approx(25.0)
        assert shot["p_mid"] == pytest.approx(46.0)

    def test_mass_palla_gram_maund_quintal_convert_to_kg(self):
        palla = rg.normalize_unit_price("potato", "প্রতি ৫ কেজি", 175.0, 200.0)
        assert palla["valid"] and palla["unit"] == "প্রতি কেজি" and palla["p_mid"] == pytest.approx(37.5)

        palla_word = rg.normalize_unit_price("onion_local", "পাল্লা", 300.0, 325.0)
        assert palla_word["valid"] and palla_word["p_mid"] == pytest.approx(62.5)

        poa = rg.normalize_unit_price("green_chili", "২৫০ গ্রাম", 30.0, 35.0)
        assert poa["valid"] and poa["p_mid"] == pytest.approx(130.0)

        maund = rg.normalize_unit_price("potato", "প্রতি মণ", 1600.0, 1600.0)
        assert maund["valid"] and maund["p_mid"] == pytest.approx(40.0)

        quintal = rg.normalize_unit_price("onion_local", "কুইন্টাল", 6500.0, 6500.0)
        assert quintal["valid"] and quintal["p_mid"] == pytest.approx(65.0)

    def test_zero_negative_and_incompatible_rejected(self):
        z = rg.normalize_unit_price("onion_import", "প্রতি কেজি", 0.0, 0.0)
        assert not z["valid"] and z["unit_status"] == "invalid_price"

        neg = rg.normalize_unit_price("potato", "প্রতি কেজি", -10.0, 40.0)
        assert not neg["valid"] and neg["unit_status"] == "invalid_price"

        inc = rg.normalize_unit_price("potato", "প্রতি লিটার", 50.0, 55.0)
        assert not inc["valid"] and inc["unit_status"] == "incompatible"

    def test_sanitize_tcb_core_audits_and_drops_bad_rows(self):
        df = pd.DataFrame([
            dict(date="2026-10-01", commodity="egg_farm", item="ডিম", unit="প্রতি হালি", p_min=48.0, p_max=50.0, p_mid=49.0),
            dict(date="2026-10-02", commodity="egg_farm", item="ডিম", unit="প্রতি ডজন", p_min=144.0, p_max=150.0, p_mid=147.0),
            dict(date="2026-10-02", commodity="onion_import", item="পেঁয়াজ", unit="প্রতি কেজি", p_min=0.0, p_max=0.0, p_mid=0.0),
            dict(date="2026-10-03", commodity="potato", item="আলু", unit="প্রতি লিটার", p_min=40.0, p_max=40.0, p_mid=40.0),
        ])
        out, audit = rg.sanitize_tcb_core(df)
        assert audit == dict(kept=2, converted=1, dropped_invalid_price=1, dropped_incompatible_unit=1)
        assert out.iloc[1]["p_mid"] == pytest.approx(49.0)
        assert out.iloc[1]["unit"] == "প্রতি হালি"
        assert out.iloc[1]["unit_status"] == "converted"


class TestImplicitUnitGuard:
    def test_catches_unlabelled_dozen_and_piece_without_contaminating_anchor(self):
        idx = pd.date_range("2025-01-01", periods=25, freq="D")
        vals = [48.0] * 15 + [144.0, 147.0] + [48.0] * 5 + [12.0, 48.0, 48.0]
        s = pd.Series(vals, index=idx)
        out = rg.flag_implicit_unit_mismatches(s, "egg_farm")
        assert out.loc[idx[15], "unit_suspect"] and out.loc[idx[15], "unit_factor_est"] == pytest.approx(3.0)
        assert out.loc[idx[16], "unit_suspect"] and out.loc[idx[16], "unit_factor_est"] == pytest.approx(3.0)
        assert out.loc[idx[22], "unit_suspect"] and out.loc[idx[22], "unit_factor_est"] == pytest.approx(0.25)
        assert np.isnan(out.loc[idx[15], "clean_price"])
        assert not out.loc[idx[17], "unit_suspect"]

    def test_genuine_35_pct_jump_not_quarantined(self):
        idx = pd.date_range("2025-01-01", periods=25, freq="D")
        vals = [50.0] * 15 + [67.5] * 10
        out = rg.flag_implicit_unit_mismatches(pd.Series(vals, index=idx), "onion_local")
        assert not out["unit_suspect"].any()

    def test_five_x_palla_spike_on_potato_quarantined(self):
        idx = pd.date_range("2025-01-01", periods=20, freq="D")
        vals = [40.0] * 14 + [200.0, 200.0] + [40.0] * 4
        out = rg.flag_implicit_unit_mismatches(pd.Series(vals, index=idx), "potato")
        assert out.loc[idx[14], "unit_suspect"] and out.loc[idx[14], "unit_factor_est"] == pytest.approx(5.0)
        assert not out.loc[idx[16], "unit_suspect"]


class TestStalenessAndTrust:
    def test_staleness_band_scale_exact_one_when_healthy(self):
        sc = rg.staleness_band_scale([14, 15, 16, 17], [1, 2, 3, 5], horizon=14)
        np.testing.assert_allclose(sc, 1.0)

    def test_staleness_band_scale_widens_and_caps_on_missing_week(self):
        sc = rg.staleness_band_scale([21, 28, 120], [7, 14, 60], horizon=14, max_scale=1.65)
        assert sc[0] > 1.0 and sc[1] > sc[0] and sc[2] == pytest.approx(1.65)

    def test_assess_reporting_trust_withholds_bad_unit_and_caps_isolated_gap(self):
        idx = pd.date_range("2025-05-01", periods=3, freq="D")
        df = pd.DataFrame(dict(
            obs_gap_days=[1, 8, 1],
            gap_days=[14, 21, 14],
            band_inflation=[1.0, 1.35, 1.0],
            unit_status=["canonical", "canonical", "suspect_unlabelled"],
            unit_suspect=[False, False, True],
            unit_factor_est=[1.0, 1.0, 3.0],
            model_status=["Normal", "Unusual", "Unusual"],
            model_dir=["", "up", "up"],
            model_reason=["", "outside_range", "outside_range"],
        ), index=idx)
        out = rg.assess_reporting_trust(df, commodity="egg_farm")
        assert out.iloc[0]["data_trust"] == "high"
        assert out.iloc[1]["data_trust"] == "caution" and out.iloc[1]["model_status"] == "Watch"
        assert out.iloc[2]["data_trust"] == "degraded" and out.iloc[2]["model_status"] == "Normal"
        assert out.iloc[2]["signal_withheld"]
