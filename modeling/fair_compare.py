"""FairPrice BD — compare model and baseline at the SAME false-alarm rate.

The default status rule gives the baseline about four times more false
alarms than the model, so its occasionally longer lead times are not a fair
win. Here each method gets one alert score per day:

    model     score = log(price / mid) / log(hi80 / mid)
    baseline  score = (price - mean84) / (1.2816 * sd84)

Score 1 = the upper edge of the 80% range; only upward moves count. We sweep
the alert threshold, measure false alarms per 100 normal days (days outside
any event window) and, for every known event, the first alert between 30
days before it starts and its peak. Then we read off both methods at the
same false-alarm levels.

Run after train_quantile.py:
    python modeling/fair_compare.py
Writes reports/model/fair_compare.csv, fair_compare_events.csv, fair_compare.png
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
import sys
MODEL = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "reports/model"
EVENTS = ROOT / "data/events.csv"
TARGET_FA = [1, 2, 5, 10]          # false alarms per 100 normal days
THRESHOLDS = np.round(np.arange(0.5, 15.01, 0.02), 2)


def load():
    ev = pd.read_csv(EVENTS, parse_dates=["start", "peak", "end"])
    frames = []
    for p in sorted(MODEL.glob("*_predictions.csv")):
        r = pd.read_csv(p, parse_dates=["date"])
        c = r.commodity.iloc[0]
        m_up = np.log(r.model_hi80 / r.model_mid)
        r["score_model"] = np.log(r.y_price / r.model_mid) / m_up.where(m_up > 1e-6)
        mid = (r.baseline_lo80 + r.baseline_hi80) / 2
        half = (r.baseline_hi80 - r.baseline_lo80) / 2
        r["score_baseline"] = (r.y_price - mid) / half.where(half > 1e-6)
        in_ev = pd.Series(False, index=r.index)
        for _, e in ev[ev.commodity == c].iterrows():
            in_ev |= (r.date >= e.start - pd.Timedelta(days=30)) & (r.date <= e.end)
        r["normal"] = ~in_ev
        frames.append(r[["date", "commodity", "y_price", "score_model", "score_baseline", "normal"]])
    return pd.concat(frames, ignore_index=True), ev


def sweep(df, ev, method):
    """For each threshold: pooled false-alarm rate and lead time per event."""
    col = f"score_{method}"
    normal = df[df.normal]
    windows = {}
    for _, e in ev.iterrows():
        w = df[(df.commodity == e.commodity) & (df.date >= e.start - pd.Timedelta(days=30)) & (df.date <= e.peak)]
        if len(w):
            windows[e.event_id] = (w, e.peak)
    rows = []
    for t in THRESHOLDS:
        fa = (normal[col] > t).sum() / len(normal) * 100
        leads = {}
        for eid, (w, peak) in windows.items():
            hit = w[w[col] > t]
            leads[eid] = (peak - hit.date.min()).days if len(hit) else np.nan
        rows.append(dict(method=method, threshold=t, fa_per100=fa, **leads))
    return pd.DataFrame(rows), list(windows)


def at_fa(sw, target):
    """Lowest threshold whose false-alarm rate is <= target (most sensitive)."""
    ok = sw[sw.fa_per100 <= target]
    return ok.sort_values("threshold").iloc[0] if len(ok) else None


def main():
    df, ev = load()
    out, per_event = [], []
    sweeps = {}
    for method in ("model", "baseline"):
        sw, eids = sweep(df, ev, method)
        sweeps[method] = sw
        for target in TARGET_FA:
            r = at_fa(sw, target)
            if r is None:
                continue
            leads = r[eids].astype(float)
            out.append(dict(target_fa=target, method=method, threshold=r.threshold,
                            actual_fa=round(r.fa_per100, 2), events=len(eids),
                            detected=int(leads.notna().sum()),
                            median_lead=None if leads.isna().all() else float(np.nanmedian(leads)),
                            mean_lead_detected=None if leads.isna().all() else round(float(np.nanmean(leads)), 1)))
            for eid in eids:
                per_event.append(dict(target_fa=target, method=method, event_id=eid,
                                      lead_days=None if pd.isna(r[eid]) else int(r[eid])))
    summary = pd.DataFrame(out)
    summary.to_csv(MODEL / "fair_compare.csv", index=False)
    pe = pd.DataFrame(per_event).pivot_table(index=["target_fa", "event_id"], columns="method",
                                             values="lead_days", aggfunc="first").reset_index()
    pe.to_csv(MODEL / "fair_compare_events.csv", index=False)
    print(summary.to_string(index=False))
    print()
    print(pe.to_string(index=False))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(11, 4))
    for method, color in (("model", "#365e8a"), ("baseline", "#8a8f93")):
        sw = sweeps[method]
        eids = [c for c in sw.columns if c not in ("method", "threshold", "fa_per100")]
        det = sw[eids].notna().sum(axis=1)
        lead = sw[eids].fillna(0).mean(axis=1)    # missed event counts as 0 days of warning
        ax[0].plot(sw.fa_per100, det, color=color, label=method)
        ax[1].plot(sw.fa_per100, lead, color=color, label=method)
    for a, t in zip(ax, ["Events caught (of %d)" % len(eids), "Mean warning days (missed = 0)"]):
        a.set_xlim(0, 15)
        a.set_xlabel("False alarms per 100 normal days")
        a.set_title(t, fontsize=10)
        a.grid(alpha=.25)
        a.legend()
    fig.tight_layout()
    fig.savefig(MODEL / "fair_compare.png", dpi=130)
    print(f"\nSaved to {MODEL}")


if __name__ == "__main__":
    main()
