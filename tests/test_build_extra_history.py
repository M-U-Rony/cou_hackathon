import runpy
import shutil
from pathlib import Path

import pandas as pd

SCRIPT = Path(__file__).resolve().parents[1] / "pipeline" / "build_extra_history.py"


def test_scales_to_tcb_level_and_drops_zero_prices(tmp_path):
    (tmp_path / "pipeline").mkdir()
    shutil.copy(SCRIPT, tmp_path / "pipeline" / "build_extra_history.py")
    (tmp_path / "data/external/agripricebd").mkdir(parents=True)
    (tmp_path / "data/processed").mkdir(parents=True)
    pd.DataFrame({
        "date": ["2024-01-01", "2024-01-02", "2024-01-03"],
        "retail price minimum": [100.0, 0.0, 120.0],      # Jan 2 = portal outage
        "retail price maximum": [120.0, 0.0, 140.0],
    }).to_csv(tmp_path / "data/external/agripricebd/green_chilli.csv", index=False)

    runpy.run_path(str(tmp_path / "pipeline" / "build_extra_history.py"), run_name="__main__")

    out = pd.read_csv(tmp_path / "data/processed/extra_history.csv")
    assert list(out.columns) == ["date", "commodity", "p_mid", "source"]
    assert list(out.date) == ["2024-01-01", "2024-01-03"]
    assert set(out.commodity) == {"green_chili"}
    scale = round(0.88 / 0.69, 3)
    assert out.p_mid.tolist() == [round(110 * scale, 2), round(130 * scale, 2)]
