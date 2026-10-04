# Alessandro Caforio — portfolio

Source for [alessandrocaforio.github.io](https://alessandrocaforio.github.io),
a Quarto site about forecasting, time series, and reproducible data work.

## What is on the site

- **Projects:** a benchmark of Italian electricity demand using Terna's public
  Total Load API. The [benchmark script](projects/energy-demand/benchmark.py)
  recomputes the reported metrics from a local Parquet extract.
- **Data Sciences:** public notebooks on linear regression and PyTorch autograd.
- **About:** professional background and contact details.

Some writing and reading notes remain drafts. The production build uses
`draft-mode: gone`; the local editor shows drafts for review.

## Edit and preview

This repository includes a local browser editor with the source on the left
and a Quarto preview on the right. It edits the real `.qmd`, theme, and site
configuration files. On macOS, double-click `_editor/Apri editor.command`, or
start it from a terminal:

```bash
python3 _editor/server.py
```

Open `http://127.0.0.1:4300/`, edit a file, then press **⌘S** to save and
render. Use **Pubblica** to select the changed files, write a commit message,
and push them. GitHub Actions then updates the public site. The editor uses
Python's standard library and a local Quarto install
under `.tools/bin/quarto` when present. You can also use a system installation
of Quarto. For a production build:

```bash
./.tools/bin/quarto render
```

**Chat AI** in the editor uses the local Codex CLI signed in with your ChatGPT
account. It sends your message and, only when the checkbox is selected, the
currently open page to Codex. It can suggest an exact text change for your
review. **Applica al testo** changes only the unsaved editor text; **⌘S** saves
it locally and **Pubblica** is still a separate step. The editor sends no
other files, and no API key is stored in this repository.

## Publish

The GitHub Actions workflow in `.github/workflows/publish.yml` renders the
site on pushes to `main` and deploys `_site` to GitHub Pages. The repository's
Pages source is configured as **GitHub Actions**.

Only source code and derived aggregate results belong here. Raw Terna extracts,
API credentials, and employer data are intentionally excluded.
