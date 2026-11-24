"""FairPrice BD — turn one day's numbers into a waterfall and a Bangla paragraph.

Works on one row of reports/model/<commodity>_predictions.csv, which holds
the walk-forward range, the status and the TreeSHAP contributions
(shap_<feature>, in log-return units) of that month's median model.

The text is built from a template, so every number in it comes from the
model. An LLM may later be used only to smooth the wording, never to decide.
"""
from __future__ import annotations

import math

import pandas as pd

COMMODITY_BN = {
    "onion_local": ("দেশি পেঁয়াজ", "কেজি"),
    "onion_import": ("আমদানি করা পেঁয়াজ", "কেজি"),
    "egg_farm": ("ফার্মের ডিম", "হালি"),
    "potato": ("আলু", "কেজি"),
    "green_chili": ("কাঁচা মরিচ", "কেজি"),
}
GENITIVE_BN = {"onion_local": "দেশি পেঁয়াজের", "onion_import": "আমদানি করা পেঁয়াজের",
               "egg_farm": "ফার্মের ডিমের", "potato": "আলুর", "green_chili": "কাঁচা মরিচের"}

# features that mean the same thing to a reader are merged into one group
GROUP_EN = {"season": "Season", "momentum": "Last 2 weeks' trend",
            "vs_avg": "Price vs recent average", "volatility": "Recent volatility",
            "yoy": "Same time last year", "festival": "Ramadan & Eid",
            "data_gap": "Data gap", "dollar": "Dollar rate", "rain": "Rainfall"}

GROUPS = {
    "season": (["doy_sin", "doy_cos", "month"], "বছরের মৌসুম"),
    "momentum": (["ret_14_28"], "আগের দুই সপ্তাহের দামের গতি"),
    "vs_avg": (["ret_ref_roll28", "ret_ref_roll84"], "সাম্প্রতিক গড়ের তুলনায় দাম"),
    "volatility": (["vol_28", "vol_84", "range_28"], "সাম্প্রতিক দামের ওঠানামা"),
    "yoy": (["yoy"], "গত বছরের একই সময়ের দাম"),
    "festival": (["days_to_ramadan", "in_ramadan", "days_to_fitr",
                  "days_to_adha", "days_after_adha"], "রমজান ও ঈদ"),
    "data_gap": (["gap_days"], "তথ্যের ফাঁক"),
    "dollar": (["fx_chg30_lag30", "fx_chg90_lag30", "fx_chg30_lag60"], "ডলারের দাম"),
    "rain": (["rain_7", "rain_30", "rain_90"], "উৎপাদন এলাকার বৃষ্টি"),
}

STATUS_BN = {"Normal": "স্বাভাবিক", "Watch": "নজরে রাখুন", "Unusual": "অস্বাভাবিক"}

# The words shown to people. Same four verdicts in the app and in the text.
# A falling price is reported separately: it is not a warning for shoppers.
VERDICT_BN = {"ok": "ঠিক আছে", "watch": "একটু বেশি", "alarm": "অনেক বেশি",
              "down": "স্বাভাবিকের চেয়ে কম"}


def verdict_key(status: str, direction: str) -> str:
    if status == "Normal":
        return "ok"
    if direction == "down":
        return "down"
    return "alarm" if status == "Unusual" else "watch"

_BN_DIGITS = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")


def bn_num(x: float, nd: int = 0) -> str:
    s = f"{x:,.{nd}f}" if nd else f"{round(x):,}"
    return s.translate(_BN_DIGITS)


def bn_date(d) -> str:
    d = pd.Timestamp(d)
    months = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই",
              "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"]
    return f"{bn_num(d.day)} {months[d.month - 1]} {bn_num(d.year)}".replace(",", "")


def grouped_contribs(row: pd.Series) -> dict[str, float]:
    """Sum log-unit SHAP values into reader-friendly groups."""
    out = {}
    for g, (feats, _) in GROUPS.items():
        cols = [f"shap_{f}" for f in feats if f"shap_{f}" in row.index]
        if cols:
            out[g] = float(sum(row[c] for c in cols if pd.notna(row[c])))
    return out


def waterfall(row: pd.Series) -> list[dict]:
    """Steps in Taka from the reference price (14 days earlier) to the
    expected price, then the unexplained part up to the actual price.
    Log contributions are converted one after another, so the steps add up
    exactly: ref + steps = expected, expected + unexplained = actual."""
    ref = float(row["ref_price"])
    steps = [dict(key="ref", label="১৪ দিন আগের দাম", label_en="Price 14 days earlier", value=ref, kind="start")]
    cur = ref * math.exp(float(row.get("shap_bias", 0.0)))
    steps.append(dict(key="bias", label="সাধারণ প্রবণতা", label_en="Model baseline", value=cur - ref, kind="step"))
    contribs = grouped_contribs(row)
    for g in sorted(contribs, key=lambda k: -abs(contribs[k])):
        new = cur * math.exp(contribs[g])
        steps.append(dict(key=g, label=GROUPS[g][1], label_en=GROUP_EN[g], value=new - cur, kind="step"))
        cur = new
    steps.append(dict(key="expected", label="প্রত্যাশিত দাম", label_en="Expected price", value=cur, kind="total"))
    actual = float(row["y_price"])
    steps.append(dict(key="unexplained", label="ব্যাখ্যাহীন অংশ", label_en="Unexplained", value=actual - cur, kind="residual"))
    steps.append(dict(key="actual", label="আসল দাম", label_en="Actual price", value=actual, kind="total"))
    return steps


def paragraph(row: pd.Series, commodity: str, date) -> str:
    name, unit = COMMODITY_BN.get(commodity, (commodity, "একক"))
    st = row["model_status"]
    y, mid = float(row["y_price"]), float(row["model_mid"])
    lo, hi = float(row["model_lo80"]), float(row["model_hi80"])
    u = (y / mid - 1) * 100

    gen = GENITIVE_BN.get(commodity, f"{name}-এর")
    s = [f"{bn_date(date)}: ঢাকায় {gen} TCB দাম {bn_num(y, 1 if y % 1 else 0)} টাকা/{unit}।",
         f"১৪ দিন আগের তথ্য দিয়ে প্রত্যাশিত দাম ছিল {bn_num(lo)}–{bn_num(hi)} টাকা "
         f"(মাঝামাঝি {bn_num(mid)} টাকা)।",
         f"অবস্থা: **{VERDICT_BN[verdict_key(st, row.get('model_dir', '') if isinstance(row.get('model_dir', ''), str) else '')]}**।"]

    contribs = grouped_contribs(row)
    top = [g for g in sorted(contribs, key=lambda k: -abs(contribs[k])) if abs(contribs[g]) >= 0.01][:2]
    if top:
        parts = []
        for g in top:
            pct = (math.exp(contribs[g]) - 1) * 100
            verb = "বাড়িয়েছে" if pct > 0 else "কমিয়েছে"
            parts.append(f"{GROUPS[g][1]} প্রত্যাশিত দাম প্রায় {bn_num(abs(pct))}% {verb}")
        s.append("মডেলের হিসাবে " + ", আর ".join(parts) + "।")

    if st == "Normal":
        s.append("দাম প্রত্যাশিত সীমার ভেতরে আছে।")
        if row.get("surge_stage", "") == "emerging":
            sc_pct = bn_num(round(float(row.get("surge_score", 0.6) or 0.6) * 100))
            why = "দ্রুত দাম লাফানোর গতি" if row.get("surge_reason", "") == "velocity_shock" else "ধারাবাহিক ঊর্ধ্বমুখী চাপ"
            s.append(f"আগাম ঊর্ধ্বমুখী চাপ (চাপ সূচক {sc_pct}%): অ্যানোমালি নিশ্চিত হওয়ার আগেই {why} দেখা যাচ্ছে, তাই নজরে রাখা ভালো।")
    elif row.get("model_reason", "") == "steady_rise":
        s.append(f"দাম এখনো প্রত্যাশিত সীমার ভেতরে, কিন্তু টানা কয়েক দিন ধরে সীমার উপরের দিকে আছে "
                 f"(প্রত্যাশার চেয়ে {bn_num(u)}% বেশি)। ধীরে ধীরে দাম বাড়ার শুরু হতে পারে, তাই নজরে রাখা ভালো।")
    elif u > 0:
        s.append(f"আসল দাম প্রত্যাশার চেয়ে {bn_num(u)}% বেশি। "
                 "এই বাড়তি অংশটা মৌসুম, আগের দাম বা উৎসব দিয়ে ব্যাখ্যা করা যায় না।")
        if st == "Unusual":
            s.append("কয়েক দিন এমন চললে সরবরাহ বা বাজার পরিস্থিতির খোঁজ নেওয়া দরকার।")
    else:
        s.append(f"আসল দাম প্রত্যাশার চেয়ে {bn_num(-u)}% কম, অর্থাৎ দাম প্রত্যাশার চেয়ে বেশি পড়েছে। "
                 "ক্রেতার জন্য এটা সতর্কসংকেত নয়।")
    trust_note = row.get("trust_note_bn", "")
    if isinstance(trust_note, str) and trust_note.strip():
        s.append(f"(তথ্য সতর্কতা: {trust_note.strip()}।)")
    s.append("(এটা মডেলের ব্যাখ্যা, কারসাজির প্রমাণ নয়।)")
    return " ".join(s)
