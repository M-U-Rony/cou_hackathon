"""FairPrice BD — dollar-rate and rainfall ablation.

Trains four versions (walk-forward, same as the main model) and compares
false alarms, coverage and event lead times per commodity:
    base   : current features
    fx     : + BDT/USD % changes (30-60 day lag)
    rain   : + rainfall in producing districts
    fx_rain: both
Run from the repo root:  python modeling/run_ablation.py
Writes reports/ablation/summary.csv and events.csv
"""
import subprocess
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "reports/ablation"
CONFIGS = {"base": ["--fx", "none", "--rain", "none"],
           "fx": ["--fx", "all", "--rain", "none"],
           "rain": ["--fx", "none", "--rain", "all"],
           "fx_rain": ["--fx", "all", "--rain", "all"]}

summ, evs = [], []
for name, flags in CONFIGS.items():
    out = OUT / name
    if not (out / "metrics.csv").exists():
        subprocess.run([sys.executable, str(ROOT / "modeling/train_quantile.py"), "--out", str(out), *flags],
                       check=True, stdout=subprocess.DEVNULL)
    m = pd.read_csv(out / "metrics.csv")
    m = m[m.method == "model"].assign(config=name)
    summ.append(m[["config", "commodity", "coverage80", "coverage95", "median_width80_pct", "unusual_per100_normal_days"]])
    e = pd.read_csv(out / "events_eval.csv")
    evs.append(e[e.method == "model"].assign(config=name)[["config", "event_id", "commodity", "lead_days_to_peak"]])
    print("done", name)

s = pd.concat(summ).pivot(index="commodity", columns="config")
e = pd.concat(evs).pivot(index=["commodity", "event_id"], columns="config", values="lead_days_to_peak")
s.to_csv(OUT / "summary.csv")
e.to_csv(OUT / "events.csv")
pd.set_option("display.width", 200)
print(s[["unusual_per100_normal_days", "coverage80", "median_width80_pct"]].round(2))
print(e[list(CONFIGS)])
