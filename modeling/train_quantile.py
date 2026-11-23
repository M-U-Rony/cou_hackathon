"""FairPrice BD — expected price range model (walk-forward).

For each commodity and each day t it predicts the price range that would be
"normal" using only information available 14 days earlier (horizon H).
Then it compares the real TCB price with that range:

    Normal  : inside the 80% band
    Watch   : outside the 80% band, inside the 95% band
    Unusual : outside the 95% band

Model : LightGBM quantile regression (falls back to sklearn
        HistGradientBoosting if LightGBM is not installed)
Bands : conformalized quantile regression (CQR) on a held-out calibration
        slice, so the coverage is honest.
Explain: LightGBM pred_contrib (TreeSHAP) for the median model, turned into
        short Bangla sentences. Explanation only, not causal.

Run from the repo root:
    python modeling/train_quantile.py
Outputs go to reports/model/.
"""
from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=UserWarning)

try:
    import lightgbm as lgb
    HAVE_LGB = True
except ImportError:  # fallback so the script still runs
    from sklearn.ensemble import HistGradientBoostingRegressor
    HAVE_LGB = False

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/processed/tcb_core.csv"
EXTRA = ROOT / "data/processed/extra_history.csv"   # pre-TCB history (green chili)
EVENTS = ROOT / "data/events.csv"
CALENDAR = ROOT / "data/calendar_bd.csv"
FX_FILE = ROOT / "data/external/bdt_usd.csv"          # date,bdt_per_usd[,source]
RAIN_FILE = ROOT / "data/external/rain_daily.csv"     # date,location,precip_mm
OUT = ROOT / "reports/model"

H = 14                      # forecast horizon in days (no copying yesterday)
QUANTILES = {"lo95": 0.025, "lo80": 0.10, "mid": 0.50, "hi80": 0.90, "hi95": 0.975}
MIN_TRAIN_ROWS = 250
CALIB_FRAC = 0.2

FEATURE_BN = {
    "ret_14_28": "আগের দুই সপ্তাহের দামের গতি",
    "ret_ref_roll84": "৩ মাসের গড়ের তুলনায় দাম",
    "ret_ref_roll28": "১ মাসের গড়ের তুলনায় দাম",
    "vol_28": "সাম্প্রতিক দামের ওঠানামা",
    "vol_84": "৩ মাসের দামের ওঠানামা",
    "yoy": "গত বছরের একই সময়ের তুলনায় দাম",
    "doy_sin": "বছরের মৌসুম",
    "doy_cos": "বছরের মৌসুম",
    "month": "মাস",
    "gap_days": "শেষ তথ্যের পর কত দিন",
    "range_28": "সাম্প্রতিক দামের পরিসর",
    "days_to_ramadan": "রমজান কাছে আসা",
    "in_ramadan": "রমজান মাস",
    "days_to_fitr": "ঈদুল ফিতর কাছে আসা",
    "days_to_adha": "ঈদুল আজহা কাছে আসা",
    "days_after_adha": "ঈদুল আজহার পরের দিনগুলো",
    "fx_chg30_lag30": "ডলারের দাম (১ মাস আগের পরিবর্তন)",
    "fx_chg90_lag30": "ডলারের দাম (৩ মাসের পরিবর্তন)",
    "fx_chg30_lag60": "ডলারের দাম (২ মাস আগের পরিবর্তন)",
    "rain_7": "সাম্প্রতিক বৃষ্টি (উৎপাদন এলাকা)",
    "rain_30": "গত মাসের বৃষ্টি (উৎপাদন এলাকা)",
    "rain_90": "গত তিন মাসের বৃষ্টি (উৎপাদন এলাকা)",
}

# producing districts whose rain may move each commodity's price
RAIN_REGIONS = {
    "onion_local": ["pabna", "faridpur", "rajshahi"],
    "onion_import": ["pabna", "faridpur", "rajshahi"],
    "potato": ["bogura", "rajshahi"],
    "egg_farm": ["dhaka"],
    "green_chili": ["bogura", "jessore"],
}


def fx_features(idx: pd.DatetimeIndex) -> pd.DataFrame:
    """BDT/USD as % changes, lagged 30-60 days (imports take time to arrive).
    Levels are not used: the taka weakened steadily in 2022-24, so a level
    would act as a time trend."""
    out = pd.DataFrame(index=idx)
    if not FX_FILE.exists():
        return out
    fx = pd.read_csv(FX_FILE, parse_dates=["date"]).set_index("date")["bdt_per_usd"].sort_index()
    fx = fx[~fx.index.duplicated()]
    full = pd.date_range(min(fx.index.min(), idx.min()), max(fx.index.max(), idx.max()), freq="D")
    fx = fx.reindex(full).ffill()       # monthly series -> daily step
    lag = lambda n: fx.shift(n).reindex(idx)
    out["fx_chg30_lag30"] = lag(30) / lag(60) - 1
    out["fx_chg90_lag30"] = lag(30) / lag(120) - 1
    out["fx_chg30_lag60"] = lag(60) / lag(90) - 1
    return out


def rain_features(idx: pd.DatetimeIndex, commodity: str | None) -> pd.DataFrame:
    """Rain in the producing districts, summed over windows ending at t-H."""
    out = pd.DataFrame(index=idx)
    if not RAIN_FILE.exists() or commodity not in RAIN_REGIONS:
        return out
    r = pd.read_csv(RAIN_FILE, parse_dates=["date"])
    r = r[r.location.isin(RAIN_REGIONS[commodity])]
    daily = r.groupby("date").precip_mm.mean().asfreq("D")
    for w in (7, 30, 90):
        out[f"rain_{w}"] = daily.rolling(w, min_periods=int(w * 0.8)).sum().shift(H).reindex(idx)
    return out


# ----------------------------------------------------------------- calendar
def calendar_features(idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Ramadan / Eid timing for each target date. These dates are known in
    advance, so using them for day t is not leakage."""
    cal = pd.read_csv(CALENDAR, parse_dates=["ramadan_start", "eid_fitr", "eid_adha"])
    out = pd.DataFrame(index=idx)
    t = idx.values

    def days_to_next(dates, cap):
        d = np.sort(dates.values)
        j = np.searchsorted(d, t, side="left")
        nxt = d[np.minimum(j, len(d) - 1)]
        days = (nxt - t) / np.timedelta64(1, "D")
        days = np.where(j >= len(d), cap, days)
        return np.clip(days, 0, cap)

    def days_since_last(dates, cap):
        d = np.sort(dates.values)
        j = np.searchsorted(d, t, side="right") - 1
        prev = d[np.maximum(j, 0)]
        days = (t - prev) / np.timedelta64(1, "D")
        days = np.where(j < 0, cap, days)
        return np.clip(days, 0, cap)

    out["days_to_ramadan"] = days_to_next(cal.ramadan_start, 60)
    out["days_to_fitr"] = days_to_next(cal.eid_fitr, 45)
    out["days_to_adha"] = days_to_next(cal.eid_adha, 45)
    out["days_after_adha"] = days_since_last(cal.eid_adha, 30)
    inr = np.zeros(len(idx), dtype=int)
    for _, r in cal.iterrows():
        inr |= ((idx >= r.ramadan_start) & (idx < r.eid_fitr)).astype(int)
    out["in_ramadan"] = inr
    return out


# ----------------------------------------------------------------- features
def build_features(s: pd.Series, commodity: str | None = None) -> pd.DataFrame:
    """s: observed mid price indexed by date (irregular). Returns one row per
    observed date with features that only use data up to t-H."""
    s = s.sort_index()
    s = s[~s.index.duplicated()]
    daily = s.asfreq("D")
    logp = np.log(daily)
    past = logp.shift(H)                       # info available at t-H
    ref = past.ffill(limit=14)                 # last known log price at t-H
    last_obs = pd.Series(daily.index.where(daily.notna()), index=daily.index)
    last_obs = last_obs.ffill().shift(H)

    f = pd.DataFrame(index=daily.index)
    f["ref"] = ref
    f["ret_14_28"] = ref - logp.shift(H + 14).ffill(limit=14)
    roll28 = past.rolling(28, min_periods=5)
    roll84 = past.rolling(84, min_periods=15)
    f["ret_ref_roll28"] = ref - roll28.mean()
    f["ret_ref_roll84"] = ref - roll84.mean()
    dlog = past.diff()
    f["vol_28"] = dlog.rolling(28, min_periods=5).std()
    f["vol_84"] = dlog.rolling(84, min_periods=15).std()
    f["range_28"] = roll28.max() - roll28.min()
    f["yoy"] = ref - logp.shift(365).ffill(limit=10)
    doy = f.index.dayofyear
    f["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    f["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    f["month"] = f.index.month
    f["gap_days"] = (f.index - pd.to_datetime(last_obs)).dt.days
    f = f.join(calendar_features(f.index))
    f = f.join(fx_features(f.index)).join(rain_features(f.index, commodity))

    # baseline band: rolling 84-day mean +- k*std of price, ending at t-H
    pprice = daily.shift(H)
    bm = pprice.rolling(84, min_periods=15).mean()
    bs = pprice.rolling(84, min_periods=15).std()
    f["base_mid"], f["base_sd"] = bm, bs

    f["y_price"] = daily
    f["target"] = logp - ref                   # log return vs reference
    f = f[daily.notna() & f["ref"].notna()]
    return f


BASE_FEATS = ["ret_14_28", "ret_ref_roll28", "ret_ref_roll84", "vol_28", "vol_84",
              "range_28", "yoy", "doy_sin", "doy_cos", "month", "gap_days"]
CAL_FEATS = ["days_to_ramadan", "in_ramadan", "days_to_fitr", "days_to_adha", "days_after_adha"]
# Ablation (Nov 2026, walk-forward 2023+): Ramadan/Eid features improved
# egg_farm (autumn-2026 spike caught, fewer false alarms), hurt potato
# (lead time 13 -> 4 days) and did not change onions. Kept only where they help.
CALENDAR_FOR = {"egg_farm"}
FX_FEATS = ["fx_chg30_lag30", "fx_chg90_lag30", "fx_chg30_lag60"]
RAIN_FEATS = ["rain_7", "rain_30", "rain_90"]
# Dollar / rain ablation (Nov 2026, modeling/run_ablation.py):
#  fx  : egg_farm slightly better (Oct-2024 event 11 -> 14 days, same false
#        alarms); onions and potato worse (potato lead 49 -> 17 days)
#  rain: potato bands narrower (36.4% -> 34.5%) with same false alarms and
#        lead; eggs and onions worse
FX_FOR = {"egg_farm"}
RAIN_FOR = {"potato"}
FEATS = list(BASE_FEATS)         # set per commodity in main()


# ------------------------------------------------------------------- models
def make_model(alpha: float):
    if HAVE_LGB:
        return lgb.LGBMRegressor(objective="quantile", alpha=alpha,
                                 n_estimators=300, learning_rate=0.03,
                                 num_leaves=15, min_child_samples=20,
                                 subsample=0.8, subsample_freq=1,
                                 colsample_bytree=0.8, verbose=-1)
    return HistGradientBoostingRegressor(loss="quantile", quantile=alpha,
                                         max_iter=300, learning_rate=0.03,
                                         max_leaf_nodes=15, min_samples_leaf=20)


def fit_block(train: pd.DataFrame):
    n_cal = max(30, int(len(train) * CALIB_FRAC))
    fit, cal = train.iloc[:-n_cal], train.iloc[-n_cal:]
    models = {k: make_model(a).fit(fit[FEATS], fit["target"])
              for k, a in QUANTILES.items()}
    # CQR adjustment for each band
    adj = {}
    for band, alpha in (("80", 0.20), ("95", 0.05)):
        lo = models[f"lo{band}"].predict(cal[FEATS])
        hi = models[f"hi{band}"].predict(cal[FEATS])
        y = cal["target"].to_numpy()
        e = np.maximum(lo - y, y - hi)
        n = len(e)
        level = min(1.0, np.ceil((n + 1) * (1 - alpha)) / n)
        adj[band] = float(np.quantile(e, level))
    return models, adj


def predict_block(models, adj, test: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=test.index)
    ref = np.exp(test["ref"])
    preds = {k: m.predict(test[FEATS]) for k, m in models.items()}
    out["mid"] = ref * np.exp(preds["mid"])
    out["ref_price"] = ref
    if HAVE_LGB:  # TreeSHAP of the median model, in log-return units
        contrib = models["mid"].predict(test[FEATS], pred_contrib=True)
        for i, k in enumerate(FEATS):
            out[f"shap_{k}"] = contrib[:, i]
        out["shap_bias"] = contrib[:, -1]
    for band in ("80", "95"):
        lo = np.minimum(preds[f"lo{band}"], preds["mid"]) - adj[band]
        hi = np.maximum(preds[f"hi{band}"], preds["mid"]) + adj[band]
        out[f"lo{band}"] = ref * np.exp(lo)
        out[f"hi{band}"] = ref * np.exp(hi)
    return out


# Steady rise (spec F2): price stays in the upper part of the expected range
# for a TCB working week. Score 1 = upper edge of the 80% range.
# Chosen Nov 2026 with modeling/fair_compare.py: catches slow climbs (potato
# 2024: 13 -> 49 days of warning) for ~2 extra Watch days per 100 normal days.
STEADY_SCORE, STEADY_DAYS = 0.6, 5


def steady_rise(y, mid, hi80):
    score = np.log(y / mid) / np.log(np.maximum(hi80 / mid, 1 + 1e-6))
    above = (score > STEADY_SCORE).astype(int)
    run = above.groupby((above == 0).cumsum()).cumsum()
    return run >= STEADY_DAYS


def flag(y, lo80, hi80, lo95, hi95):
    status = np.where((y > hi95) | (y < lo95), "Unusual",
                      np.where((y > hi80) | (y < lo80), "Watch", "Normal"))
    direction = np.where(y > hi80, "up", np.where(y < lo80, "down", ""))
    return status, direction


# --------------------------------------------------------------- walk-forward
def walk_forward(f: pd.DataFrame, test_start: str, step_months: int):
    starts = pd.date_range(test_start, f.index.max(), freq=f"{step_months}MS")
    parts = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else f.index.max() + pd.Timedelta(days=1)
        train = f[f.index < s - pd.Timedelta(days=0)]
        test = f[(f.index >= s) & (f.index < e)]
        if len(train) < MIN_TRAIN_ROWS or test.empty:
            continue
        models, adj = fit_block(train)
        p = predict_block(models, adj, test)
        parts.append(p)
    if not parts:
        return None
    return pd.concat(parts)


# --------------------------------------------------------------- evaluation
def evaluate(res: pd.DataFrame, events: pd.DataFrame, commodity: str):
    rows, ev_rows = [], []
    ev = events[events.commodity == commodity]
    in_event = pd.Series(False, index=res.index)
    for _, e in ev.iterrows():
        in_event |= (res.index >= e.start - pd.Timedelta(days=30)) & (res.index <= e.end)

    for name in ("model", "baseline"):
        st, dr = res[f"{name}_status"], res[f"{name}_dir"]
        cov80 = ((res.y_price >= res[f"{name}_lo80"]) & (res.y_price <= res[f"{name}_hi80"])).mean()
        cov95 = ((res.y_price >= res[f"{name}_lo95"]) & (res.y_price <= res[f"{name}_hi95"])).mean()
        width80 = ((res[f"{name}_hi80"] - res[f"{name}_lo80"]) / res.y_price).median()
        normal = ~in_event
        fa = ((st == "Unusual") & normal).sum() / max(1, normal.sum()) * 100
        rows.append(dict(commodity=commodity, method=name, n_days=len(res),
                         coverage80=round(cov80, 3), coverage95=round(cov95, 3),
                         median_width80_pct=round(width80 * 100, 1),
                         unusual_per100_normal_days=round(fa, 2)))
        for _, e in ev.iterrows():
            win = res[(res.index >= e.start - pd.Timedelta(days=30)) & (res.index <= e.peak)]
            hit = win[(win[f"{name}_status"] != "Normal") & (win[f"{name}_dir"] == "up")]
            first = hit.index.min() if len(hit) else pd.NaT
            first_u = win[(win[f"{name}_status"] == "Unusual") & (win[f"{name}_dir"] == "up")].index.min()
            ev_rows.append(dict(event_id=e.event_id, commodity=commodity, method=name,
                                covered_by_test=len(win) > 0,
                                detected=pd.notna(first),
                                first_flag=None if pd.isna(first) else first.date(),
                                first_unusual=None if pd.isna(first_u) else first_u.date(),
                                lead_days_to_peak=None if pd.isna(first) else (e.peak - first).days))
    return rows, ev_rows


# -------------------------------------------------------------- explanation
def explain_latest(f: pd.DataFrame, res: pd.DataFrame, commodity: str, n_last: int = 60):
    """Fit the median model on all data and explain the last n days."""
    if not HAVE_LGB:
        return None
    m = make_model(0.5).fit(f[FEATS], f["target"])
    tail = f.iloc[-n_last:]
    contrib = m.predict(tail[FEATS], pred_contrib=True)
    cdf = pd.DataFrame(contrib[:, :-1], columns=FEATS, index=tail.index)
    rows = []
    for d, r in cdf.iterrows():
        top = r.abs().sort_values(ascending=False).index[:3]
        parts = []
        for k in top:
            pct = (np.exp(r[k]) - 1) * 100
            sign = "বাড়িয়েছে" if pct > 0 else "কমিয়েছে"
            parts.append(f"{FEATURE_BN[k]} প্রত্যাশিত দাম {abs(pct):.1f}% {sign}")
        unexplained = ""
        if d in res.index:
            u = (res.at[d, "y_price"] / res.at[d, "model_mid"] - 1) * 100
            unexplained = f"; প্রত্যাশার বাইরে (অব্যাখ্যাত) অংশ {u:+.1f}%"
        rows.append(dict(date=d.date(), commodity=commodity,
                         explanation_bn="; ".join(parts) + unexplained,
                         **{f"c_{k}": round(float(r[k]), 4) for k in FEATS}))
    imp = pd.Series(m.booster_.feature_importance("gain"), index=FEATS)
    return pd.DataFrame(rows), (imp / imp.sum()).round(3)


# --------------------------------------------------------------------- plot
def plot(res: pd.DataFrame, commodity: str, events: pd.DataFrame, path: Path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(13, 4.5))
    ax.fill_between(res.index, res.model_lo95, res.model_hi95, color="#9ecae1", alpha=.35, label="95% range")
    ax.fill_between(res.index, res.model_lo80, res.model_hi80, color="#4292c6", alpha=.35, label="80% range")
    ax.plot(res.index, res.y_price, color="#222", lw=1, label="TCB price")
    for st, c in (("Watch", "#f2a900"), ("Unusual", "#d62728")):
        m = res.model_status == st
        ax.scatter(res.index[m], res.y_price[m], s=12, color=c, zorder=3, label=st)
    for _, e in events[events.commodity == commodity].iterrows():
        ax.axvspan(e.start, e.end, color="#d62728", alpha=.06)
    ax.set_title(f"{commodity}: expected range (H={H}d, walk-forward) vs TCB price")
    ax.legend(loc="upper left", fontsize=8, ncol=5)
    ax.grid(alpha=.2)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


# --------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-start", default="2023-01-01")
    ap.add_argument("--step-months", type=int, default=1)
    ap.add_argument("--commodities", nargs="*",
                    default=["onion_local", "onion_import", "egg_farm", "potato", "green_chili"])
    ap.add_argument("--calendar", choices=["auto", "all", "none"], default="auto",
                    help="Ramadan/Eid features: auto = only CALENDAR_FOR, all, or none (ablation)")
    ap.add_argument("--fx", choices=["auto", "all", "none"], default="auto",
                    help="dollar-rate features: auto = only FX_FOR")
    ap.add_argument("--rain", choices=["auto", "all", "none"], default="auto",
                    help="rainfall features: auto = only RAIN_FOR")
    ap.add_argument("--out", default=None, help="output folder (default reports/model)")
    args = ap.parse_args()

    global FEATS, OUT
    if args.out:
        OUT = Path(args.out) if Path(args.out).is_absolute() else ROOT / args.out
    OUT.mkdir(parents=True, exist_ok=True)
    print("calendar features:", args.calendar)
    print(f"engine: {'LightGBM' if HAVE_LGB else 'sklearn HistGradientBoosting (install lightgbm for the real run)'}")
    data = pd.read_csv(DATA, parse_dates=["date"])
    if EXTRA.exists():   # add history only for dates before TCB lists the item
        extra = pd.read_csv(EXTRA, parse_dates=["date"])
        first = data.groupby("commodity").date.min()
        extra = extra[extra.date < extra.commodity.map(first)]
        data = pd.concat([data, extra[["date", "commodity", "p_mid"]]], ignore_index=True)
    events = pd.read_csv(EVENTS, parse_dates=["start", "peak", "end"])

    metrics, ev_all, expl_all, imps = [], [], [], {}
    for c in args.commodities:
        use_cal = args.calendar == "all" or (args.calendar == "auto" and c in CALENDAR_FOR)
        use_fx = args.fx == "all" or (args.fx == "auto" and c in FX_FOR)
        use_rain = args.rain == "all" or (args.rain == "auto" and c in RAIN_FOR)
        FEATS = (list(BASE_FEATS) + (CAL_FEATS if use_cal else [])
                 + (FX_FEATS if use_fx else []) + (RAIN_FEATS if use_rain else []))
        s = data[data.commodity == c].set_index("date")["p_mid"]
        f = build_features(s, c)
        FEATS = [k for k in FEATS if k in f.columns]
        print(f"{c}: {len(FEATS)} features"
              + (" +calendar" if use_cal else "") + (" +fx" if use_fx and "fx_chg30_lag30" in f else "")
              + (" +rain" if use_rain and "rain_30" in f else ""))
        res = walk_forward(f, args.test_start, args.step_months)
        if res is None:
            print(f"{c}: skipped (not enough history, {len(f)} rows)")
            continue
        res = res.join(f[["y_price", "base_mid", "base_sd"]])
        res.columns = ["model_" + k if k in ("mid", "lo80", "hi80", "lo95", "hi95") else k for k in res.columns]
        res["commodity"] = c
        res["baseline_mid"] = res.base_mid
        for band, z in (("80", 1.2816), ("95", 1.96)):
            res[f"baseline_lo{band}"] = res.base_mid - z * res.base_sd
            res[f"baseline_hi{band}"] = res.base_mid + z * res.base_sd
        res = res.dropna(subset=["baseline_lo80"])
        for name in ("model", "baseline"):
            res[f"{name}_status"], res[f"{name}_dir"] = flag(
                res.y_price, res[f"{name}_lo80"], res[f"{name}_hi80"],
                res[f"{name}_lo95"], res[f"{name}_hi95"])
        steady = steady_rise(res.y_price, res.model_mid, res.model_hi80) & (res.model_status == "Normal")
        res.loc[steady, "model_status"] = "Watch"
        res.loc[steady, "model_dir"] = "up"
        res["model_reason"] = np.where(steady, "steady_rise",
                                       np.where(res.model_status != "Normal", "outside_range", ""))
        res["unexplained_pct"] = (res.y_price / res.model_mid - 1) * 100
        res.drop(columns=["base_mid", "base_sd"]).round(4).to_csv(OUT / f"{c}_predictions.csv", index_label="date")

        m, e = evaluate(res, events, c)
        metrics += m
        ev_all += e
        plot(res, c, events, OUT / f"{c}_range.png")
        ex = explain_latest(f, res, c)
        if ex is not None:
            expl_all.append(ex[0])
            imps[c] = ex[1].to_dict()
        print(f"{c}: {len(res)} test days | " +
              " | ".join(f"{r['method']} cov80={r['coverage80']} cov95={r['coverage95']} FA={r['unusual_per100_normal_days']}" for r in m))

    pd.DataFrame(metrics).to_csv(OUT / "metrics.csv", index=False)
    pd.DataFrame(ev_all).to_csv(OUT / "events_eval.csv", index=False)
    if expl_all:
        pd.concat(expl_all).to_csv(OUT / "explanations_latest.csv", index=False)
        (OUT / "feature_importance.json").write_text(json.dumps(imps, indent=2, ensure_ascii=False))
    print("\nEvents:")
    print(pd.DataFrame(ev_all).to_string(index=False))
    print(f"\nSaved to {OUT}")


if __name__ == "__main__":
    main()
