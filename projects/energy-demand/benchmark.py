"""Recompute the February 2026 national load benchmark.

Input: a Parquet extract of Terna's Total Load API with columns date,
date_offset, bidding_zone, total_load_MW, forecast_total_load_MW.

Example:
    python benchmark.py /path/to/total_load.parquet

Requires pandas, numpy, and a Parquet engine such as pyarrow. No credentials or
raw observations are included in this site repository.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

START = "2026-02-01"
END = "2026-02-28 23:45:00"


def benchmark(path: Path) -> pd.DataFrame:
    columns = [
        "date", "date_offset", "bidding_zone", "total_load_MW",
        "forecast_total_load_MW",
    ]
    data = pd.read_parquet(path, columns=columns)
    data = data.loc[data["bidding_zone"].eq("Italy")].copy()
    data["timestamp"] = pd.to_datetime(
        data["date"] + data["date_offset"],
        format="%Y-%m-%d %H:%M:%S%z", utc=True,
    )
    data["actual"] = pd.to_numeric(data["total_load_MW"], errors="coerce")
    data["terna"] = pd.to_numeric(
        data["forecast_total_load_MW"], errors="coerce"
    )
    data = data.set_index("timestamp").sort_index()[["actual", "terna"]]
    if data.index.has_duplicates:
        raise ValueError("Duplicate Italy timestamps in the input extract")

    # Reindex by time, not row position: missing records must not shift a lag.
    for label, days in [("previous_day", 1), ("previous_week", 7)]:
        data[label] = data["actual"].reindex(
            data.index - pd.Timedelta(days=days)
        ).to_numpy()

    window = data.loc[START:END].dropna()
    expected = pd.date_range(START, END, freq="15min", tz="UTC")
    if not window.index.equals(expected):
        raise ValueError("February 2026 coverage is incomplete or misaligned")
    if (window["actual"] <= 0).any():
        raise ValueError("MAPE requires positive actual load")

    results = []
    for label in ["terna", "previous_week", "previous_day"]:
        error = window[label] - window["actual"]
        results.append({
            "forecast": label,
            "observations": len(window),
            "mae_mw": error.abs().mean(),
            "rmse_mw": np.sqrt(error.pow(2).mean()),
            "mape_percent": (error.abs() / window["actual"]).mean() * 100,
        })
    return pd.DataFrame(results)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parquet", type=Path)
    args = parser.parse_args()
    print(benchmark(args.parquet).to_string(index=False, float_format="%.2f"))
