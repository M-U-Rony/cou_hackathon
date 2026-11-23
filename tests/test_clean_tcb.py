import pandas as pd
import pytest

import clean_tcb as ct


class TestNorm:
    def test_collapses_whitespace_and_strips(self):
        assert ct.norm("  আলু   ভালো \n") == "আলু ভালো"

    def test_none_and_empty(self):
        assert ct.norm(None) == ""
        assert ct.norm("") == ""

    def test_nfc_canonical_form(self):
        # precomposed য় (U+09DF) and য + nukta must end up identical
        assert ct.norm("য়") == ct.norm("য়")


class TestNum:
    @pytest.mark.parametrize("raw,expected", [
        ("৪৫", 45.0),
        ("৪৭.৫", 47.5),
        ("1,250", 1250.0),
        ("৳ ৮০ টাকা", 80.0),
        ("120", 120.0),
    ])
    def test_parses_bangla_and_ascii_digits(self, raw, expected):
        assert ct.num(raw) == expected

    @pytest.mark.parametrize("raw", ["", "-", "n/a", ".", None])
    def test_unparseable_is_none(self, raw):
        assert ct.num(raw) is None

    def test_double_dot_is_none_not_crash(self):
        assert ct.num("1.2.3") is None


class TestCoreRegexes:
    def match(self, code, name):
        return bool(ct.CORE[code].search(ct.norm(name).replace(" ", "")))

    @pytest.mark.parametrize("name", ["পেঁয়াজ (দেশী)", "পিঁয়াজ দেশী"])
    def test_local_onion(self, name):
        assert self.match("onion_local", name)
        assert not self.match("onion_import", name)

    def test_import_onion(self):
        assert self.match("onion_import", "পেঁয়াজ (আমদানি)")
        assert not self.match("onion_local", "পেঁয়াজ (আমদানি)")

    def test_potato_egg_chili(self):
        assert self.match("potato", "আলু (সাধারণ)")
        assert self.match("egg_farm", "ডিম(ফার্ম) ")
        assert self.match("green_chili", "কাঁচামরিচ")

    def test_unrelated_item_matches_nothing(self):
        assert not any(self.match(c, "মসুর ডাল") for c in ct.CORE)


@pytest.fixture
def run_clean(tmp_path, monkeypatch, tcb_raw_rows):
    def go(rows):
        raw = tmp_path / "raw.csv"
        pd.DataFrame(rows).to_csv(raw, index=False)
        out = tmp_path / "out"
        out.mkdir()
        monkeypatch.setattr(ct, "RAW", raw)
        monkeypatch.setattr(ct, "OUT", out)
        ct.main()
        return out
    return go


class TestMain:
    def test_end_to_end_core_and_long(self, run_clean, tcb_raw_rows):
        r = tcb_raw_rows
        rows = [
            r("f1", 1, "আলু (সাধারণ)", "কেজি", "৪০", "৫০"),
            r("f1", 2, "ডিম(ফার্ম)", "হালি", "৪৮", "৫২"),
            r("f1", 3, "মসুর ডাল", "কেজি", "১২০", "১৩০"),
            r("f1", 4, "যে সকল বাজার থেকে তথ্য", "", "", ""),     # stop line
            r("f1", 5, "আলু (সাধারণ)", "কেজি", "৯৯৯", "৯৯৯"),    # after stop: ignored
        ]
        out = run_clean(rows)
        core = pd.read_csv(out / "tcb_core.csv")
        assert set(core.commodity) == {"potato", "egg_farm"}
        potato = core[core.commodity == "potato"].iloc[0]
        assert (potato.p_min, potato.p_max, potato.p_mid) == (40, 50, 45)
        long = pd.read_csv(out / "tcb_all_long.csv")
        assert len(long) == 3                       # lentils kept in the long file only
        assert (out / "tcb_qc.txt").read_text(encoding="utf-8").startswith("raw rows:")

    def test_min_greater_than_max_is_swapped(self, run_clean, tcb_raw_rows):
        out = run_clean([tcb_raw_rows("f1", 1, "আলু (সাধারণ)", "কেজি", "৬০", "৪০")])
        row = pd.read_csv(out / "tcb_core.csv").iloc[0]
        assert (row.p_min, row.p_max, row.p_mid) == (40, 60, 50)

    def test_missing_max_falls_back_to_min(self, run_clean, tcb_raw_rows):
        out = run_clean([tcb_raw_rows("f1", 1, "আলু (সাধারণ)", "কেজি", "৪২", "")])
        row = pd.read_csv(out / "tcb_core.csv").iloc[0]
        assert row.p_max == 42 and row.p_mid == 42

    def test_duplicate_item_in_same_file_keeps_first(self, run_clean, tcb_raw_rows):
        r = tcb_raw_rows
        out = run_clean([r("f1", 1, "আলু (সাধারণ)", "কেজি", "40", "40"),
                         r("f1", 2, "আলু (সাধারণ)", "কেজি", "99", "99")])
        core = pd.read_csv(out / "tcb_core.csv")
        assert len(core) == 1 and core.p_mid.iloc[0] == 40

    def test_same_date_two_files_prefers_subheader_source(self, run_clean, tcb_raw_rows):
        r = tcb_raw_rows
        out = run_clean([r("f1", 1, "আলু (সাধারণ)", "কেজি", "50", "50", src="listing"),
                         r("f2", 1, "আলু (সাধারণ)", "কেজি", "40", "40", src="subhdr")])
        core = pd.read_csv(out / "tcb_core.csv")
        assert len(core) == 1 and core.p_mid.iloc[0] == 40

    def test_rows_without_unit_or_date_are_dropped(self, run_clean, tcb_raw_rows):
        r = tcb_raw_rows
        out = run_clean([r("f1", 1, "আলু (সাধারণ)", "", "40", "40"),                    # no unit
                         r("f1", 2, "ডিম(ফার্ম)", "হালি", "48", "48", date=""),         # no date
                         r("f1", 3, "ডিম(ফার্ম)", "হালি", "", "")])                    # no price
        assert len(pd.read_csv(out / "tcb_all_long.csv")) == 0
