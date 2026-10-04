"""Recompute the national load benchmark and its monthly extension.

Input: a Parquet extract of Terna's Total Load API with columns date,
date_offset, bidding_zone, total_load_MW, forecast_total_load_MW.

Example:
    python benchmark.py /path/to/total_load.parquet
    python benchmark.py /path/to/total_load.parquet --monthly

Requires pandas, numpy, and a Parquet engine such as pyarrow. No credentials or
raw observations are included in this site repository.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

def load_panel(path: Path) -> pd.DataFrame:
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
    return data


def complete_month(data: pd.DataFrame, month: str) -> pd.DataFrame:
    period = pd.Period(month, freq="M")
    start = period.start_time.tz_localize("UTC")
    stop = (period + 1).start_time.tz_localize("UTC")
    expected = pd.date_range(start, stop, freq="15min", inclusive="left")
    window = data.loc[(data.index >= start) & (data.index < stop)]
    if not window.index.equals(expected):
        raise ValueError(f"{month} coverage is incomplete or misaligned")
    if window.isna().any().any():
        raise ValueError(f"{month} has missing actual, forecast, or baseline values")
    if (window["actual"] <= 0).any():
        raise ValueError(f"{month} has nonpositive actual load")
    return window


def benchmark(path: Path) -> pd.DataFrame:
    data = load_panel(path)
    window = complete_month(data, "2026-02")

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


def monthly_benchmark(path: Path, first: str = "2026-02", last: str = "2026-05") -> pd.DataFrame:
    data = load_panel(path)
    windows = []
    rows = []
    for period in pd.period_range(first, last, freq="M"):
        window = complete_month(data, str(period))
        windows.append(window)
        rows.append({
            "month": str(period),
            "observations": len(window),
            **{f"{label}_mae_mw": (window[label] - window["actual"]).abs().mean()
               for label in ("terna", "previous_week", "previous_day")},
        })
    if not windows:
        raise ValueError("No months selected")
    pooled = pd.concat(windows)
    rows.append({
        "month": "pooled",
        "observations": len(pooled),
        **{f"{label}_mae_mw": (pooled[label] - pooled["actual"]).abs().mean()
           for label in ("terna", "previous_week", "previous_day")},
    })
    return pd.DataFrame(rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parquet", type=Path)
    parser.add_argument("--monthly", action="store_true", help="Show complete-month MAE, February–May 2026")
    args = parser.parse_args()
    result = monthly_benchmark(args.parquet) if args.monthly else benchmark(args.parquet)
    print(result.to_string(index=False, float_format="%.2f"))
