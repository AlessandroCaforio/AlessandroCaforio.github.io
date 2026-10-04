# Alessandro Caforio — portfolio

Source for [alessandrocaforio.github.io](https://alessandrocaforio.github.io),
a Quarto site about forecasting, time series, and reproducible data work.

## What is on the site

- **Projects:** a benchmark of Italian electricity demand using Terna's public
  Total Load API. The [benchmark script](projects/energy-demand/benchmark.py)
  recomputes the reported metrics from a local Parquet extract.
- **About:** professional background and contact details.

Writing, reading notes, and notebooks are kept as drafts until they are ready
to publish. The production build uses `draft-mode: gone`; the local editor
shows drafts for review.

## Edit and preview

This repository includes a local browser editor with the source on the left
and a Quarto preview on the right. It edits the real `.qmd`, theme, and site
configuration files.

```bash
python3 _editor/server.py
```

Open `http://127.0.0.1:4300/`, edit a file, then press **⌘S** to save and
render. The editor uses Python's standard library and a local Quarto install
under `.tools/bin/quarto` when present. You can also use a system installation
of Quarto. For a production build:

```bash
./.tools/bin/quarto render
```

## Publish

The GitHub Actions workflow in `.github/workflows/publish.yml` renders the
site on pushes to `main` and deploys `_site` to GitHub Pages. The repository
needs **Settings → Pages → Source: GitHub Actions**.

Only source code and derived aggregate results belong here. Raw Terna extracts,
API credentials, and employer data are intentionally excluded.
