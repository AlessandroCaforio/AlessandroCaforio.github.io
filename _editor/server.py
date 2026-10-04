#!/usr/bin/env python3
"""Editor del sito — server locale.

Un Overleaf per questo sito: sorgente a sinistra, sito compilato a destra.
Solo libreria standard di Python, niente da installare.

    python3 _editor/server.py            # apre il browser su 127.0.0.1:4300
    python3 _editor/server.py --no-browser

Il server ascolta solo su 127.0.0.1: dalla rete non lo raggiunge nessuno.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import webbrowser
from datetime import date
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
EDITOR = ROOT / "_editor"
STATIC = EDITOR / "static"
TEMPLATES = EDITOR / "templates"
COMMANDS = EDITOR / "comandi.tex"
# L'anteprima dell'editor vive qui, non in _site: cosi' non litiga con un
# `quarto preview` aperto nel terminale, e _site resta quello che produce Quarto.
PREVIEW = EDITOR / ".preview"

PORT = int(os.environ.get("EDITOR_PORT", "4300"))
HOST = "127.0.0.1"

_local_quarto = ROOT / ".tools" / "bin" / "quarto"
QUARTO = str(_local_quarto) if _local_quarto.exists() else shutil.which("quarto")

# Cosa si puo' aprire nell'editor. I notebook si vedono ma non si toccano:
# si scrivono e si eseguono nel loro progetto (vedi README §6).
EDITABLE = {".qmd", ".md", ".yml", ".yaml", ".scss", ".css", ".html", ".tex", ".txt"}
VIEW_ONLY = {".ipynb"}
SKIP_DIRS = {".git", ".quarto", ".tools", "_site", "_freeze", "__pycache__", ".obsidian",
             "node_modules", ".preview", "static", ".github", ".claude", "site_libs"}

RENDER_LOCK = threading.Lock()
ANSI = re.compile(r"\x1b\[[0-9;]*m")


# --- Percorsi ----------------------------------------------------------------

def safe_path(rel, must_exist=True):
    """Da percorso relativo a Path dentro ROOT, o ValueError."""
    if not rel or "\x00" in rel:
        raise ValueError("percorso vuoto")
    p = (ROOT / rel).resolve()
    if p != ROOT and ROOT not in p.parents:
        raise ValueError("fuori dal sito")
    parts = p.relative_to(ROOT).parts
    if any(part in SKIP_DIRS for part in parts[:-1]):
        raise ValueError("cartella esclusa")
    if p.suffix not in EDITABLE | VIEW_ONLY:
        raise ValueError(f"tipo di file non gestito: {p.suffix}")
    if must_exist and not p.is_file():
        raise FileNotFoundError(rel)
    return p


def front_matter(p):
    """Titolo, data e bozza dal frontmatter: l'albero mostra nomi veri, non slug."""
    try:
        if p.suffix == ".ipynb":
            cells = json.loads(p.read_text()).get("cells", [])
            head = "".join(cells[0].get("source", [])) if cells and cells[0].get("cell_type") == "raw" else ""
        else:
            head = p.read_text()[:4000]
    except (OSError, ValueError, AttributeError):
        return {}
    m = re.match(r"\s*---\n(.*?)\n---", head, re.S)
    if not m:
        return {}
    meta = {}
    for key in ("title", "pagetitle", "date", "draft"):
        km = re.search(rf"^{key}:[ \t]*(.+?)[ \t]*(#.*)?$", m.group(1), re.M)
        if km:
            meta[key] = str(_unquote(km.group(1)))
    out = {}
    if meta.get("title") or meta.get("pagetitle"):
        out["title"] = meta.get("title") or meta.get("pagetitle")
    if meta.get("date"):
        out["date"] = meta["date"]
    if meta.get("draft", "").lower() in ("true", "yes"):
        out["draft"] = True
    return out


def group_of(rel):
    """In che sezione dell'albero va un file: il sito pensato per contenuti, non per cartelle."""
    parts = rel.split("/")
    name = parts[-1]
    if parts[0] == "_editor" or "_templates" in parts:
        return "editor"
    if name.endswith(".ipynb"):
        return "notebooks"
    if name.endswith((".scss", ".css")) or parts[0] == "assets":
        return "style"
    if name.endswith((".yml", ".yaml")):
        return "settings"
    if parts[0] == "posts" and not any(x.startswith("_") for x in parts):
        return "posts"
    if parts[0] == "projects":
        return "projects"
    if len(parts) == 1 and name.endswith((".qmd", ".md")) and not name.startswith("_") and name.lower() != "readme.md":
        return "pages"
    return "notes"


def list_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            p = Path(dirpath) / name
            if p.suffix in EDITABLE or p.suffix in VIEW_ONLY:
                rel = p.relative_to(ROOT).as_posix()
                entry = {"path": rel, "editable": p.suffix in EDITABLE, "group": group_of(rel)}
                if p.suffix in {".qmd", ".md", ".ipynb"}:
                    entry.update(front_matter(p))
                out.append(entry)
    return out


def slugify(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "senza-titolo"


# --- YAML "chirurgico" ---------------------------------------------------------
# _quarto.yml e' pieno di commenti che valgono quanto il codice. Un parser YAML
# li perderebbe alla prima scrittura, quindi qui si toccano solo le righe dei
# valori cambiati, e tutto il resto del file resta byte per byte com'era.

def _indent(line):
    return len(line) - len(line.lstrip(" "))


def _meaningful(line):
    s = line.strip()
    return bool(s) and not s.startswith("#")


def _block_end(lines, idx):
    """Prima riga dopo il blocco che inizia in idx (commenti in coda esclusi)."""
    base = _indent(lines[idx])
    end = len(lines)
    for i in range(idx + 1, len(lines)):
        if _meaningful(lines[i]) and _indent(lines[i]) <= base:
            end = i
            break
    while end > idx + 1 and not _meaningful(lines[end - 1]):
        end -= 1
    return end


def yaml_find(lines, path):
    start, end, parent_indent, idx = 0, len(lines), -1, None
    for key in path:
        idx, child_indent = None, None
        for i in range(start, end):
            if not _meaningful(lines[i]):
                continue
            ind = _indent(lines[i])
            if ind <= parent_indent:
                break
            if child_indent is None:
                child_indent = ind
            if ind == child_indent and re.match(rf"{re.escape(key)}\s*:", lines[i].strip()):
                idx = i
                break
        if idx is None:
            return None
        parent_indent, start, end = _indent(lines[idx]), idx + 1, _block_end(lines, idx)
    return idx


def _split_value(raw):
    """'  "abc"   # nota' -> ('"abc"', '   # nota')"""
    raw = raw.rstrip("\n")
    s = raw.lstrip()
    lead = raw[: len(raw) - len(s)]
    if s[:1] in ('"', "'"):
        q, i = s[0], 1
        while i < len(s):
            if s[i] == "\\" and q == '"':
                i += 2
                continue
            if s[i] == q:
                break
            i += 1
        return lead + s[: i + 1], s[i + 1 :]
    m = re.search(r"\s+#", s)
    return (lead + s[: m.start()], s[m.start() :]) if m else (lead + s, "")


def _unquote(v):
    v = v.strip()
    if v.startswith('"'):
        try:
            return json.loads(v)
        except ValueError:
            return v.strip('"')
    if v.startswith("'"):
        return v[1:-1].replace("''", "'")
    return v


def _format_value(value, was_quoted):
    if isinstance(value, bool):
        return "true" if value else "false"
    value = str(value)
    bare_ok = re.fullmatch(r"[\w][\w .\-/]*", value) and value.lower() not in {"true", "false", "yes", "no", "null", "on", "off"}
    if was_quoted or not bare_ok:
        return json.dumps(value, ensure_ascii=False)
    return value


def yaml_get(text, path):
    lines = text.split("\n")
    i = yaml_find(lines, path)
    if i is None:
        return None
    value, _ = _split_value(lines[i].split(":", 1)[1])
    return _unquote(value)


def yaml_set(text, path, value):
    lines = text.split("\n")
    i = yaml_find(lines, path)
    if i is None:
        raise KeyError(".".join(path))
    head, rest = lines[i].split(":", 1)
    old, comment = _split_value(rest)
    quoted = old.strip()[:1] in ('"', "'")
    lines[i] = f"{head}: {_format_value(value, quoted)}{comment}"
    return "\n".join(lines)


def yaml_get_list(text, path):
    """Lista di mappe semplici (es. website.navbar.left)."""
    lines = text.split("\n")
    i = yaml_find(lines, path)
    if i is None:
        return []
    items = []
    for line in lines[i + 1 : _block_end(lines, i)]:
        if not _meaningful(line):
            continue
        s = line.strip()
        if s.startswith("- "):
            items.append({})
            s = s[2:]
        if items and ":" in s:
            k, v = s.split(":", 1)
            items[-1][k.strip()] = _unquote(_split_value(v)[0])
    return items


def yaml_set_list(text, path, items, keys=("href", "text")):
    lines = text.split("\n")
    i = yaml_find(lines, path)
    if i is None:
        raise KeyError(".".join(path))
    end = _block_end(lines, i)
    first = next((l for l in lines[i + 1 : end] if l.strip().startswith("- ")), None)
    ind = " " * (_indent(first) if first else _indent(lines[i]) + 2)
    block = []
    for item in items:
        ordered = [k for k in keys if item.get(k)] + [k for k in item if k not in keys and item.get(k)]
        for n, k in enumerate(ordered):
            prefix = f"{ind}- " if n == 0 else f"{ind}  "
            block.append(f"{prefix}{k}: {_format_value(item[k], False)}")
    lines[i + 1 : end] = block
    return "\n".join(lines)


# --- Temi SCSS e manopole CSS ----------------------------------------------------

SCSS_VAR = re.compile(r"^\$([\w-]+):[ \t]*([^;\n]+);", re.M)
CSS_KNOB = re.compile(r"(--site-([\w-]+):[ \t]*)([^;\n]+)(;)")
COLOR_KEYS = ["paper", "ink", "ink-muted", "accent", "accent-soft", "rule", "surface", "code-color"]
TYPE_KEYS = ["font-family-base", "headings-font-family", "font-family-serif", "font-family-sans-serif",
             "font-family-monospace", "font-size-root", "line-height-base", "headings-font-weight"]
CSS_KNOBS = ["measure", "radius", "section-gap", "nav-case"]
PAGE_KEYS = ["toc", "toc-depth", "toc-title", "code-copy", "link-external-newwindow"]


def scss_vars(text):
    return {m.group(1): m.group(2).strip() for m in SCSS_VAR.finditer(text)}


def scss_set(text, name, value):
    return re.sub(rf"^(\${re.escape(name)}:[ \t]*)[^;\n]+;", lambda m: f"{m.group(1)}{value};", text, count=1, flags=re.M)


def css_knobs(text):
    root = re.search(r":root\s*\{[^}]*\}", text)
    return {m.group(2): m.group(3).strip() for m in CSS_KNOB.finditer(root.group(0))} if root else {}


def css_knob_set(text, name, value):
    root = re.search(r":root\s*\{[^}]*\}", text)
    if not root:
        return text
    block = re.sub(rf"(--site-{re.escape(name)}:[ \t]*)[^;\n]+(;)", lambda m: f"{m.group(1)}{value}{m.group(2)}", root.group(0), count=1)
    return text[: root.start()] + block + text[root.end() :]


def _clean(value, what):
    value = str(value).strip()
    if not value or re.search(r"[;{}\n]", value):
        raise ValueError(f"valore non valido per {what}: {value!r}")
    return value


def read_layout():
    q = (ROOT / "_quarto.yml").read_text()
    light = scss_vars((ROOT / "theme-light.scss").read_text())
    dark = scss_vars((ROOT / "theme-dark.scss").read_text())
    return {
        "site": {
            "title": yaml_get(q, ["website", "title"]),
            "description": yaml_get(q, ["website", "description"]),
            "footer_left": yaml_get(q, ["website", "page-footer", "left"]),
        },
        "navbar": [{"text": it.get("text", ""), "href": it.get("href", "")}
                   for it in yaml_get_list(q, ["website", "navbar", "left"])],
        "page": {k: yaml_get(q, ["format", "html", k]) for k in PAGE_KEYS},
        "light": {k: light.get(k) for k in COLOR_KEYS},
        "dark": {k: dark.get(k) for k in COLOR_KEYS},
        "type": {k: light.get(k) for k in TYPE_KEYS},
        "css": {k: css_knobs((ROOT / "styles.css").read_text()).get(k) for k in CSS_KNOBS},
    }


def write_layout(data):
    changed = []

    def update(rel, fn):
        p = ROOT / rel
        before = p.read_text()
        after = fn(before)
        if after != before:
            p.write_text(after)
            changed.append(rel)

    def quarto(text):
        for k in ("title", "description"):
            if k in data.get("site", {}):
                text = yaml_set(text, ["website", k], data["site"][k])
        if "footer_left" in data.get("site", {}):
            text = yaml_set(text, ["website", "page-footer", "left"], data["site"]["footer_left"])
        if "navbar" in data:
            items = [{"href": it["href"].strip(), "text": it["text"].strip()}
                     for it in data["navbar"] if it.get("href", "").strip()]
            if yaml_get_list(text, ["website", "navbar", "left"]) != items:
                text = yaml_set_list(text, ["website", "navbar", "left"], items)
        for k, v in data.get("page", {}).items():
            if k in PAGE_KEYS and v is not None:
                if k in ("toc", "code-copy", "link-external-newwindow"):
                    v = v in (True, "true")
                if yaml_get(text, ["format", "html", k]) != _format_value(v, False).strip('"'):
                    text = yaml_set(text, ["format", "html", k], v)
        return text

    def theme(mode):
        def fn(text):
            for k, v in data.get(mode, {}).items():
                if k in COLOR_KEYS and v:
                    if not re.fullmatch(r"#[0-9a-fA-F]{3,8}", v):
                        raise ValueError(f"colore non valido: {v}")
                    text = scss_set(text, k, v)
            for k, v in data.get("type", {}).items():
                if k in TYPE_KEYS and v:
                    text = scss_set(text, k, _clean(v, k))
            return text
        return fn

    def styles(text):
        for k, v in data.get("css", {}).items():
            if k in CSS_KNOBS and v:
                text = css_knob_set(text, k, _clean(v, k))
        return text

    update("_quarto.yml", quarto)
    update("theme-light.scss", theme("light"))
    update("theme-dark.scss", theme("dark"))
    update("styles.css", styles)
    return changed


# --- Template e comandi ----------------------------------------------------------

def parse_template(p):
    meta, body, header = {}, [], True
    for line in p.read_text().split("\n"):
        if header and line.startswith("%"):
            m = re.match(r"%\s*([\w-]+)\s*:\s*(.*)", line)
            if m:
                meta[m.group(1)] = m.group(2).strip()
            continue
        if header and not line.strip():
            continue
        header = False
        body.append(line)
    return {
        "id": p.name,
        "name": meta.get("nome", p.stem),
        "description": meta.get("descrizione", ""),
        "target": meta.get("percorso", "{{slug}}" + p.suffix),
        "after": meta.get("poi", ""),
        "body": "\n".join(body),
    }


def list_templates():
    return [parse_template(p) for p in sorted(TEMPLATES.glob("*")) if p.suffix in {".qmd", ".md"}]


def fill(text, values):
    return re.sub(r"\{\{(\w+)\}\}", lambda m: values.get(m.group(1), m.group(0)), text)


def list_commands():
    if not COMMANDS.exists():
        return []
    out, current = [], None
    for line in COMMANDS.read_text().split("\n"):
        m = re.match(r"\\newcommand\{\\([A-Za-z]+)\}\{(.*)\}\s*$", line)
        if m and current is None:
            current = {"name": m.group(1), "description": m.group(2), "lines": []}
        elif line.strip() == "\\endcommand" and current is not None:
            current["body"] = "\n".join(current.pop("lines"))
            out.append(current)
            current = None
        elif current is not None:
            current["lines"].append(line)
    return out


# --- Temi pronti e immagini ----------------------------------------------------------

PRESETS = EDITOR / "temi.json"
PRESET_TYPE_KEYS = ["font-family-base", "headings-font-family", "font-size-root", "line-height-base", "headings-font-weight"]
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
MAX_UPLOAD = 15 * 1024 * 1024


def read_presets():
    try:
        return json.loads(PRESETS.read_text())
    except FileNotFoundError:
        return []


def save_preset(data):
    """Aggiunge (o sostituisce, a parita' di id) un tema in temi.json."""
    name = str(data.get("nome", "")).strip()
    if not name:
        raise ValueError("serve un nome per il tema")
    preset = {"id": slugify(data.get("id") or name), "nome": name,
              "descrizione": str(data.get("descrizione", "")).strip()}
    for mode in ("light", "dark"):
        colors = {k: v for k, v in (data.get(mode) or {}).items() if k in COLOR_KEYS}
        for v in colors.values():
            if not re.fullmatch(r"#[0-9a-fA-F]{3,8}", v):
                raise ValueError(f"colore non valido: {v}")
        preset[mode] = colors
    # Un tema sceglie quale famiglia usare, non ridefinisce le liste di font.
    preset["type"] = {k: _clean(v, k) for k, v in (data.get("type") or {}).items() if k in PRESET_TYPE_KEYS}
    preset["css"] = {k: _clean(v, k) for k, v in (data.get("css") or {}).items() if k in CSS_KNOBS}
    presets = [p for p in read_presets() if p.get("id") != preset["id"]] + [preset]
    PRESETS.write_text(json.dumps(presets, ensure_ascii=False, indent=2) + "\n")
    return preset


def save_upload(doc_rel, name, data_b64):
    """Salva un'immagine accanto al documento, in images/, e rende il percorso da scrivere nel markdown."""
    import base64
    doc = safe_path(doc_rel)
    ext = Path(name).suffix.lower()
    if ext not in IMAGE_EXT:
        raise ValueError(f"non e' un'immagine gestita: {ext or name}")
    raw = base64.b64decode(data_b64, validate=True)
    if len(raw) > MAX_UPLOAD:
        raise ValueError("immagine oltre 15 MB")
    folder = doc.parent / "images"
    folder.mkdir(exist_ok=True)
    stem, n = slugify(Path(name).stem), 1
    target = folder / f"{stem}{ext}"
    while target.exists():
        n += 1
        target = folder / f"{stem}-{n}{ext}"
    target.write_bytes(raw)
    return {"path": f"images/{target.name}", "file": target.relative_to(ROOT).as_posix()}


# --- Quarto e git ------------------------------------------------------------------

def render():
    if not QUARTO:
        return {"ok": False, "log": "Quarto non trovato: ne' in .tools/ ne' nel PATH (vedi README §1).", "problems": []}
    with RENDER_LOCK:
        t0 = time.time()
        proc = subprocess.run(
            [QUARTO, "render", "--profile", "editor", "--output-dir", str(PREVIEW.relative_to(ROOT))],
            cwd=ROOT, capture_output=True, text=True, timeout=600,
        )
        log = ANSI.sub("", proc.stdout + proc.stderr)
    problems = [l.strip() for l in log.split("\n") if re.search(r"\b(ERROR|WARN(ING)?)\b", l)]
    return {"ok": proc.returncode == 0, "log": log, "problems": problems, "seconds": round(time.time() - t0, 1)}


def git(*args, timeout=30, raw=False):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    proc = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env)
    return proc.returncode, proc.stdout if raw else (proc.stdout + proc.stderr).strip()


def git_status():
    code, _ = git("rev-parse", "--is-inside-work-tree")
    if code != 0:
        return {"repo": False}
    _, branch = git("branch", "--show-current")
    _, remotes = git("remote")
    # -z: percorsi senza virgolette ne' escape, anche con spazi o accenti.
    _, out = git("status", "--porcelain=v1", "-uall", "-z", raw=True)
    entries, files, i = out.split("\0"), [], 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        code = entry[:2]
        if code[0] in "RC":
            i += 1  # la voce successiva e' il nome di prima
        files.append({"status": "?" if code == "??" else code.strip(), "path": entry[3:]})
    return {"repo": True, "branch": branch, "remote": "origin" in remotes.split(), "files": files}


def git_commit(message, paths, push):
    status = git_status()
    known = {f["path"] for f in status.get("files", [])}
    paths = [p for p in paths if p in known]
    if not message.strip():
        return {"ok": False, "log": "Serve un messaggio di commit."}
    if not paths:
        return {"ok": False, "log": "Nessun file selezionato."}
    log = []
    code, out = git("add", "-A", "--", *paths)
    log.append(out)
    if code == 0:
        code, out = git("commit", "-m", message, "--", *paths)
        log.append(out)
    if code == 0 and push:
        if not status.get("remote"):
            return {"ok": False, "log": "\n".join(log + ["Commit fatto, ma la repo non ha ancora un remote 'origin': vedi README §4."])}
        code, out = git("push", "-u", "origin", "HEAD", timeout=120)
        log.append(out)
    return {"ok": code == 0, "log": "\n".join(l for l in log if l)}


# --- HTTP ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    server_version = "SiteEditor/1.0"

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/api/" in msg or msg.startswith("code "):
            sys.stderr.write(f"  {msg}\n")

    # Solo richieste per 127.0.0.1/localhost: blocca il DNS rebinding.
    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in {"127.0.0.1", "localhost"}

    def _json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _serve_from(self, base, rel):
        target = (base / unquote(rel)).resolve()
        if base.resolve() not in target.parents and target != base.resolve():
            return self.send_error(HTTPStatus.FORBIDDEN)
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        ctype = self.guess_type(str(target))
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._host_ok():
            return self.send_error(HTTPStatus.FORBIDDEN)
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/":
                return self._serve_from(STATIC, "index.html")
            if url.path.startswith("/static/"):
                return self._serve_from(STATIC, url.path[len("/static/"):])
            if url.path.startswith("/site/"):
                return self._serve_from(PREVIEW, url.path[len("/site/"):])
            if url.path == "/api/status":
                return self._json({"quarto": bool(QUARTO), "preview": (PREVIEW / "index.html").exists(),
                                   "root": str(ROOT), "title": yaml_get((ROOT / "_quarto.yml").read_text(), ["website", "title"])})
            if url.path == "/api/tree":
                return self._json({"files": list_files()})
            if url.path == "/api/file":
                p = safe_path(q.get("path"))
                info = {"path": q["path"], "mtime": p.stat().st_mtime_ns, "editable": p.suffix in EDITABLE}
                if q.get("meta") != "1" and p.suffix in EDITABLE:
                    info["content"] = p.read_text()
                return self._json(info)
            if url.path == "/api/templates":
                return self._json({"templates": [{k: v for k, v in t.items() if k != "body"} for t in list_templates()]})
            if url.path == "/api/commands":
                return self._json({"commands": list_commands()})
            if url.path == "/api/layout":
                return self._json(read_layout())
            if url.path == "/api/presets":
                return self._json({"presets": read_presets()})
            if url.path == "/api/git":
                return self._json(git_status())
            return self.send_error(HTTPStatus.NOT_FOUND)
        except FileNotFoundError as e:
            return self._json({"error": f"file non trovato: {e}"}, HTTPStatus.NOT_FOUND)
        except ValueError as e:
            return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)

    def do_POST(self):
        # L'intestazione X-Editor non si puo' aggiungere da un'altra pagina web
        # senza passare dal CORS: nessun sito aperto nel browser puo' scrivere qui.
        if not self._host_ok() or self.headers.get("X-Editor") != "1":
            return self.send_error(HTTPStatus.FORBIDDEN)
        url = urlparse(self.path)
        try:
            data = self._body()
            if url.path == "/api/save":
                p = safe_path(data["path"], must_exist=False)
                if p.suffix not in EDITABLE:
                    raise ValueError("file in sola lettura")
                if p.exists() and not data.get("force") and data.get("mtime") and p.stat().st_mtime_ns != data["mtime"]:
                    return self._json({"error": "conflict", "content": p.read_text(), "mtime": p.stat().st_mtime_ns}, HTTPStatus.CONFLICT)
                p.write_text(data["content"])
                return self._json({"ok": True, "mtime": p.stat().st_mtime_ns})
            if url.path == "/api/render":
                return self._json(render())
            if url.path == "/api/new":
                tpl = next((t for t in list_templates() if t["id"] == data.get("template")), None)
                if not tpl:
                    raise ValueError("template sconosciuto")
                title = data.get("title", "").strip() or "Senza titolo"
                values = {"title": title.replace('"', '\\"'), "description": data.get("description", "").strip().replace('"', '\\"'),
                          "slug": slugify(data.get("slug") or title), "date": date.today().isoformat()}
                rel = fill(tpl["target"], values)
                p = safe_path(rel, must_exist=False)
                if p.exists():
                    return self._json({"error": f"{rel} esiste gia'"}, HTTPStatus.CONFLICT)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(fill(tpl["body"], values))
                return self._json({"ok": True, "path": rel, "after": fill(tpl["after"], values)})
            if url.path == "/api/layout":
                return self._json({"ok": True, "changed": write_layout(data)})
            if url.path == "/api/presets":
                return self._json({"ok": True, "preset": save_preset(data)})
            if url.path == "/api/upload":
                return self._json({"ok": True, **save_upload(data.get("doc", ""), data.get("name", ""), data.get("data", ""))})
            if url.path == "/api/git/commit":
                return self._json(git_commit(data.get("message", ""), data.get("paths", []), bool(data.get("push"))))
            return self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError) as e:
            return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        except subprocess.TimeoutExpired:
            return self._json({"error": "tempo scaduto"}, HTTPStatus.GATEWAY_TIMEOUT)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"Editor del sito su {url}  (Ctrl+C per chiudere)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nChiuso.")


if __name__ == "__main__":
    main()
