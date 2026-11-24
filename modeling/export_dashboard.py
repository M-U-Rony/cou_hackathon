"""FairPrice BD — package model outputs for the dashboard (F3, F4, F5, F6).

Reads reports/model/ (from train_quantile.py) and writes reports/dashboard/:
    fairprice_data.json        everything the dashboard needs, stack-neutral
    waterfall_<commodity>.png  F3 waterfall for the latest day
    replay_<event_id>.png      F4 replay chart for each known event

Run from the repo root after train_quantile.py (and fair_compare.py, optional):
    python modeling/train_quantile.py
    python modeling/fair_compare.py      # equal-false-alarm comparison (optional)
    python modeling/export_dashboard.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from explain_bn import COMMODITY_BN, STATUS_BN, paragraph, waterfall  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "reports/model"
OUT = ROOT / "reports/dashboard"
EVENTS = ROOT / "data/events.csv"
REPLAY_BEFORE = 45   # days shown before an event starts
COLORS = {"Normal": "#2ca02c", "Watch": "#f2a900", "Unusual": "#d62728"}


def r2(x):
    return None if pd.isna(x) else round(float(x), 2)


def _s(row: pd.Series, key: str, default: str = "") -> str:
    val = row.get(key, default)
    return val if isinstance(val, str) else default


def day_record(row: pd.Series, commodity: str, date, with_text=False) -> dict:
    direction = _s(row, "model_dir", "")
    status = str(row.model_status)
    default_stage = "confirmed" if (status != "Normal" and direction == "up") else "none"
    surge_stage = _s(row, "surge_stage", default_stage) or default_stage
    surge_score = r2(row["surge_score"]) if "surge_score" in row.index and pd.notna(row["surge_score"]) else (0.85 if default_stage == "confirmed" else 0.0)
    obs_gap = int(row["obs_gap_days"]) if "obs_gap_days" in row.index and pd.notna(row["obs_gap_days"]) else 1
    band_inf = r2(row["band_inflation"]) if "band_inflation" in row.index and pd.notna(row["band_inflation"]) else 1.0

    d = dict(date=str(pd.Timestamp(date).date()), price=r2(row.y_price),
             mid=r2(row.model_mid), lo80=r2(row.model_lo80), hi80=r2(row.model_hi80),
             lo95=r2(row.model_lo95), hi95=r2(row.model_hi95),
             status=status, direction=direction,
             unexplained_pct=r2(row.unexplained_pct),
             reason=_s(row, "model_reason", ""),
             baseline_status=row.baseline_status,
             surge_stage=surge_stage,
             surge_score=surge_score,
             surge_reason=_s(row, "surge_reason", ""),
             data_trust=_s(row, "data_trust", "high") or "high",
             obs_gap_days=obs_gap,
             band_inflation=band_inf,
             unit_status=_s(row, "unit_status", "canonical") or "canonical",
             trust_note_bn=_s(row, "trust_note_bn", ""))
    if with_text:
        d["text_bn"] = paragraph(row, commodity, date)
        d["waterfall"] = [{**s, "value": round(s["value"], 2)} for s in waterfall(row)]
    return d


def plot_waterfall(steps, title, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(10, 4.2))
    cur = 0.0
    for i, s in enumerate(steps):
        if s["kind"] in ("start", "total"):
            ax.bar(i, s["value"], color="#4c72b0" if s["key"] != "actual" else "#222")
            cur = s["value"]
            ax.text(i, s["value"], f"{s['value']:.1f}", ha="center", va="bottom", fontsize=8)
        else:
            c = "#d62728" if s["value"] > 0 else "#2ca02c"
            if s["kind"] == "residual":
                c = "#ff7f0e"
            ax.bar(i, s["value"], bottom=cur, color=c)
            ax.text(i, cur + max(s["value"], 0), f"{s['value']:+.1f}", ha="center", va="bottom", fontsize=8)
            cur += s["value"]
    top = max(max(s["value"] for s in steps if s["kind"] in ("start", "total")), cur)
    ax.set_ylim(0, top * 1.15)
    ax.set_xticks(range(len(steps)))
    ax.set_xticklabels([s["label_en"] for s in steps], rotation=25, ha="right", fontsize=8)
    ax.set_ylabel("Tk")
    ax.set_title(title, fontsize=10)
    ax.grid(axis="y", alpha=.2)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_replay(win: pd.DataFrame, e, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(11, 4.2))
    ax.fill_between(win.index, win.model_lo95, win.model_hi95, color="#9ecae1", alpha=.35, label="95% expected")
    ax.fill_between(win.index, win.model_lo80, win.model_hi80, color="#4292c6", alpha=.35, label="80% expected")
    ax.plot(win.index, win.y_price, color="#222", lw=1.2, label="TCB price")
    for st in ("Watch", "Unusual"):
        m = win.model_status == st
        ax.scatter(win.index[m], win.y_price[m], s=16, color=COLORS[st], zorder=3, label=st)
    if "surge_stage" in win.columns:
        em = win[win.surge_stage == "emerging"]
        if len(em):
            ax.scatter(em.index, em.y_price, marker="^", s=26, color="#ea580c", zorder=4, label="Emerging")
            em0 = em[em.index >= e.start - pd.Timedelta(days=30)].index.min()
            if pd.notna(em0):
                ax.axvline(em0, color="#ea580c", ls="-.", lw=1)
    up = win[(win.model_status != "Normal") & (win.model_dir == "up") & (win.index >= e.start - pd.Timedelta(days=30))]
    if len(up):
        ax.axvline(up.index[0], color="#f2a900", ls="--", lw=1)
        ax.text(up.index[0], ax.get_ylim()[1], " first flag", color="#b07d00", va="top", fontsize=8)
    ax.axvline(e.peak, color="#d62728", ls=":", lw=1)
    ax.text(e.peak, ax.get_ylim()[1], " peak", color="#d62728", va="top", fontsize=8)
    ax.set_title(f"Replay: {e.description}", fontsize=10)
    ax.legend(loc="upper left", fontsize=8)
    ax.grid(alpha=.2)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    events = pd.read_csv(EVENTS, parse_dates=["start", "peak", "end"])
    ev_eval = pd.read_csv(MODEL / "events_eval.csv")
    metrics = pd.read_csv(MODEL / "metrics.csv")

    data = dict(generated=str(pd.Timestamp.now().date()), horizon_days=14,
                status_bn=STATUS_BN,
                note_bn="এটা মডেলের ব্যাখ্যা, বাস্তবের কারণ বা কারসাজির প্রমাণ নয়।",
                metrics=metrics.replace({np.nan: None}).to_dict("records"),
                commodities={}, events=[])

    fc_path = MODEL / "fair_compare.csv"
    if fc_path.exists():
        fc_ev_path = MODEL / "fair_compare_events.csv"
        clean = lambda df: df.astype(object).where(df.notna(), None).to_dict("records")
        data["fair_compare"] = dict(
            summary=clean(pd.read_csv(fc_path)),
            events=clean(pd.read_csv(fc_ev_path)) if fc_ev_path.exists() else [])
    else:
        data["fair_compare"] = None
        print("hint: reports/model/fair_compare.csv missing - run `python modeling/fair_compare.py` first "
              "to add the equal-false-alarm comparison to the dashboard")

    for c in COMMODITY_BN:
        p = MODEL / f"{c}_predictions.csv"
        if not p.exists():
            continue
        res = pd.read_csv(p, parse_dates=["date"]).set_index("date").sort_index()
        last_d = res.index[-1]
        name, unit = COMMODITY_BN[c]
        data["commodities"][c] = dict(
            name_bn=name, unit_bn=unit,
            latest=day_record(res.iloc[-1], c, last_d, with_text=True),
            series=[day_record(r, c, d) for d, r in res.iterrows()])
        plot_waterfall(waterfall(res.iloc[-1]),
                       f"{c} {last_d.date()}: from price 14 days earlier to expected and actual price",
                       OUT / f"waterfall_{c}.png")

        for _, e in events[events.commodity == c].iterrows():
            win = res[(res.index >= e.start - pd.Timedelta(days=REPLAY_BEFORE)) & (res.index <= e.end)]
            if win.empty:
                continue
            ev_row = ev_eval[(ev_eval.event_id == e.event_id) & (ev_eval.method == "model")]
            base_row = ev_eval[(ev_eval.event_id == e.event_id) & (ev_eval.method == "baseline")]
            data["events"].append(dict(
                event_id=e.event_id, commodity=c, description=e.description,
                start=str(e.start.date()), peak=str(e.peak.date()), end=str(e.end.date()),
                model=ev_row.iloc[0].replace({np.nan: None}).to_dict() if len(ev_row) else None,
                baseline=base_row.iloc[0].replace({np.nan: None}).to_dict() if len(base_row) else None,
                days=[day_record(r, c, d, with_text=True) for d, r in win.iterrows()]))
            plot_replay(win, e, OUT / f"replay_{e.event_id}.png")

    mk = ROOT / "data/processed/markets.json"      # F7 / F8, from pipeline/build_markets.py
    if mk.exists():
        extra = json.loads(mk.read_text())
        data["markets"], data["spread"] = extra.get("markets", {}), extra.get("spread", {})

    audit_path = MODEL / "resilience_audit.json"
    audit = json.loads(audit_path.read_text(encoding="utf-8")) if audit_path.exists() else {}
    ev_model = ev_eval[ev_eval["method"] == "model"] if "method" in ev_eval.columns else ev_eval
    gains = [
        int(x) for x in ev_model.get("days_before_confirmed", pd.Series(dtype=float)).dropna().tolist()
        if int(x) > 0
    ]
    m_model = metrics[metrics["method"] == "model"] if "method" in metrics.columns else metrics
    em_rates = m_model.get("emerging_per100_normal_days", pd.Series(dtype=float)).dropna()
    data["resilience"] = {
        "early_surge": {
            "events_total": int(len(ev_model)),
            "events_flagged_before_confirm": int(len(gains)),
            "median_extra_lead_days": round(float(np.median(gains)), 1) if gains else 0.0,
            "max_extra_lead_days": int(max(gains)) if gains else 0,
            "mean_normal_emerging_per_100d": round(float(em_rates.mean()), 2) if len(em_rates) else 0.0,
        },
        "reporting_guard": {
            "gap_widened_days": int(sum(v.get("gap_widened_days", 0) for v in audit.values())),
            "caution_days": int(sum(v.get("caution_days", 0) for v in audit.values())),
            "degraded_days": int(sum(v.get("degraded_days", 0) for v in audit.values())),
            "post_gap_capped_days": int(sum(v.get("post_gap_capped_days", 0) for v in audit.values())),
            "quarantined_implicit_unit_rows": int(sum(v.get("quarantined_implicit_unit_rows", 0) for v in audit.values())),
            "converted_explicit_unit_rows": int(sum(v.get("converted_explicit_unit_rows", 0) for v in audit.values())),
            "per_commodity": audit,
        },
    }
    (OUT / "fairprice_data.json").write_text(json.dumps(data, ensure_ascii=False, default=str))
    print(f"commodities: {list(data['commodities'])}")
    print(f"events replayed: {[e['event_id'] for e in data['events']]}")
    for c, v in data["commodities"].items():
        print(f"\n[{c}] latest {v['latest']['date']}: {v['latest']['status']}\n{v['latest']['text_bn']}")
    print(f"\nSaved to {OUT}")


if __name__ == "__main__":
    main()
