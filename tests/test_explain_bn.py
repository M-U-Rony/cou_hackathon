import math

import pandas as pd
import pytest

import explain_bn as eb


def make_row(**kw):
    base = dict(y_price=60.0, model_mid=50.0, model_lo80=45.0, model_hi80=55.0,
                model_lo95=40.0, model_hi95=62.0, model_status="Unusual", model_dir="up",
                model_reason="", ref_price=48.0, shap_bias=0.02,
                shap_doy_sin=0.05, shap_doy_cos=0.01, shap_month=0.0,   # season group
                shap_ret_14_28=-0.03,                                   # momentum
                shap_yoy=0.0)
    base.update(kw)
    return pd.Series(base)


class TestBnNum:
    def test_digits_converted(self):
        assert eb.bn_num(45) == "৪৫"

    def test_thousands_separator_kept(self):
        assert eb.bn_num(1234567) == "১,২৩৪,৫৬৭"

    def test_decimals(self):
        assert eb.bn_num(47.5, 1) == "৪৭.৫"
        assert eb.bn_num(0.25, 2) == "০.২৫"

    def test_zero_decimals_rounds(self):
        assert eb.bn_num(47.6) == "৪৮"


class TestBnDate:
    def test_format_has_no_comma_in_year(self):
        assert eb.bn_date("2026-03-05") == "৫ মার্চ ২০২৬"

    def test_all_months_have_names(self):
        names = {eb.bn_date(f"2025-{m:02d}-01").split()[1] for m in range(1, 13)}
        assert len(names) == 12

    def test_accepts_timestamp(self):
        assert eb.bn_date(pd.Timestamp("2024-12-31")) == "৩১ ডিসেম্বর ২০২৪"


class TestVerdict:
    @pytest.mark.parametrize("status,direction,expected", [
        ("Normal", "", "ok"),
        ("Normal", "up", "ok"),
        ("Watch", "up", "watch"),
        ("Unusual", "up", "alarm"),
        ("Watch", "down", "down"),
        ("Unusual", "down", "down"),      # falling is never an alarm for shoppers
        ("Watch", "", "watch"),           # steady rise: status Watch with no direction
    ])
    def test_verdict_key(self, status, direction, expected):
        assert eb.verdict_key(status, direction) == expected

    def test_every_verdict_has_bangla_word(self):
        assert set(eb.VERDICT_BN) == {"ok", "watch", "alarm", "down"}

    def test_status_words_cover_model_statuses(self):
        assert set(eb.STATUS_BN) == {"Normal", "Watch", "Unusual"}


class TestGroupedContribs:
    def test_sums_features_within_group(self):
        g = eb.grouped_contribs(make_row())
        assert g["season"] == pytest.approx(0.06)
        assert g["momentum"] == pytest.approx(-0.03)

    def test_groups_without_columns_are_absent(self):
        g = eb.grouped_contribs(make_row())
        assert "rain" not in g and "dollar" not in g

    def test_nan_contribution_ignored(self):
        g = eb.grouped_contribs(make_row(shap_doy_sin=float("nan")))
        assert g["season"] == pytest.approx(0.01)


class TestWaterfall:
    def test_steps_add_up_exactly(self):
        row = make_row()
        steps = eb.waterfall(row)
        assert steps[0]["key"] == "ref" and steps[0]["value"] == 48.0
        exp = next(s for s in steps if s["key"] == "expected")
        # ref + all steps before 'expected' == expected
        assert 48.0 + sum(s["value"] for s in steps if s["kind"] == "step") == pytest.approx(exp["value"])
        # expected + unexplained == actual
        un = next(s for s in steps if s["key"] == "unexplained")
        assert exp["value"] + un["value"] == pytest.approx(60.0)
        assert steps[-1]["key"] == "actual" and steps[-1]["value"] == 60.0

    def test_expected_matches_log_sum(self):
        row = make_row()
        total = sum(eb.grouped_contribs(row).values()) + 0.02
        exp = next(s for s in eb.waterfall(row) if s["key"] == "expected")
        assert exp["value"] == pytest.approx(48.0 * math.exp(total))

    def test_group_steps_sorted_by_abs_size(self):
        keys = [s["key"] for s in eb.waterfall(make_row()) if s["kind"] == "step" and s["key"] != "bias"]
        assert keys == ["season", "momentum", "yoy"]   # |0.06| > |0.03| > |0|

    def test_labels_present_in_both_languages(self):
        for s in eb.waterfall(make_row()):
            assert s["label"] and s["label_en"]


class TestParagraph:
    def test_unusual_up(self):
        t = eb.paragraph(make_row(), "potato", "2026-03-05")
        assert t.startswith("৫ মার্চ ২০২৬: ঢাকায় আলুর TCB দাম ৬০ টাকা/কেজি।")
        assert "**অনেক বেশি**" in t
        assert "২০% বেশি" in t                       # 60/50 - 1
        assert "কারসাজির প্রমাণ নয়" in t
        assert "সরবরাহ বা বাজার পরিস্থিতির খোঁজ" in t

    def test_range_numbers_come_from_row(self):
        t = eb.paragraph(make_row(), "potato", "2026-03-05")
        assert "৪৫–৫৫ টাকা" in t and "মাঝামাঝি ৫০ টাকা" in t

    def test_normal(self):
        row = make_row(y_price=50.0, model_status="Normal", model_dir="")
        t = eb.paragraph(row, "potato", "2026-03-05")
        assert "**ঠিক আছে**" in t and "প্রত্যাশিত সীমার ভেতরে আছে" in t

    def test_watch_has_no_alarm_sentence(self):
        row = make_row(model_status="Watch", y_price=57.0)
        t = eb.paragraph(row, "potato", "2026-03-05")
        assert "**একটু বেশি**" in t and "সরবরাহ বা বাজার" not in t

    def test_falling_price_is_not_a_warning(self):
        row = make_row(y_price=40.0, model_status="Watch", model_dir="down")
        t = eb.paragraph(row, "potato", "2026-03-05")
        assert "**স্বাভাবিকের চেয়ে কম**" in t
        assert "২০% কম" in t and "সতর্কসংকেত নয়" in t

    def test_steady_rise_wording(self):
        row = make_row(y_price=53.0, model_status="Watch", model_dir="", model_reason="steady_rise")
        t = eb.paragraph(row, "potato", "2026-03-05")
        assert "টানা কয়েক দিন" in t

    def test_fractional_price_keeps_one_decimal(self):
        t = eb.paragraph(make_row(y_price=47.5), "potato", "2026-03-05")
        assert "৪৭.৫ টাকা" in t

    def test_unknown_commodity_does_not_crash(self):
        assert "TCB দাম" in eb.paragraph(make_row(), "mystery", "2026-03-05")

    def test_every_commodity_has_genitive_form(self):
        assert set(eb.COMMODITY_BN) == set(eb.GENITIVE_BN)
