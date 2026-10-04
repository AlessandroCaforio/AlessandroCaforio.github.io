'use strict';
/* =============================================================================
   Editor del sito — interfaccia
   Sorgente a sinistra, sito compilato a destra. Nessuna libreria: l'editor e'
   una textarea trasparente sopra un <pre> colorato riga per riga.
   ============================================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('editor.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('editor.' + k, JSON.stringify(v)); } catch { /* storage bloccato: pazienza */ } },
};

const api = {
  async call(path, opts) {
    const r = await fetch(path, { cache: 'no-store', ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, data: j });
    return j;
  },
  get(path) { return this.call(path); },
  post(path, body) {
    return this.call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Editor': '1' }, body: JSON.stringify(body || {}) });
  },
};

const enc = encodeURIComponent;
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tok = (cls, s) => (s ? `<span class="t-${cls}">${esc(s)}</span>` : '');
const slugify = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'senza-titolo';

let toastTimer;
function toast(msg, kind = 'info', ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ----------------------------------------------------------------------- stato

const state = {
  files: [],
  commands: [],
  templates: [],
  presets: [],
  current: null,              // { path, mtime, editable, saved }
  view: 'empty',              // 'code' | 'layout' | 'empty'
  previewPage: 'index.html',
  layout: null,
  layoutSaved: null,
  layoutTab: store.get('layoutTab', 'temi'),
  colorMode: null,
  collapsed: new Set(store.get('collapsed', ['style', 'settings', 'editor', 'notes'])),
  filter: '',
  recent: store.get('recent', []),
  auto: store.get('auto', false),
  // Chiavi nuove: la prima versione salvava qui valori in un altro formato.
  device: ['desktop', 'tablet', 'phone'].includes(store.get('previewDevice')) ? store.get('previewDevice') : 'desktop',
  zoom: store.get('previewZoom') === 'real' ? 'real' : 'fit',
  viewMode: ['write', 'split', 'preview'].includes(store.get('viewMode')) ? store.get('viewMode') : 'split',
  compiling: false,
  compileAgain: false,
  needsCompile: false,        // salvato ma non ancora compilato
  lastDirty: false,
};

const ta = $('#ta');
const hl = $('#hl');
const codeScroll = $('#codeScroll');
// Due iframe: una si vede, l'altra prepara la ricompilazione e prende il suo
// posto solo quando e' pronta. Cosi' l'anteprima non lampeggia a ogni ⌘S.
let frame = $('#previewA');
let spare = $('#previewB');

function kindOf(path = '') {
  const ext = path.split('.').pop();
  return { qmd: 'md', md: 'md', yml: 'yml', yaml: 'yml', scss: 'scss', css: 'css', html: 'html', tex: 'tex' }[ext] || 'plain';
}
const isMd = () => state.view === 'code' && kindOf(state.current?.path) === 'md';

// ------------------------------------------------------------ evidenziazione

function tokenize(s, re, classes) {
  let out = '', last = 0;
  for (const m of s.matchAll(re)) {
    if (!m[0]) continue;
    out += esc(s.slice(last, m.index));
    const gi = m.findIndex((g, i) => i > 0 && g !== undefined);
    const cls = classes[gi - 1];
    out += typeof cls === 'function' ? cls(m[0]) : tok(cls, m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

const MD_INLINE = /(`[^`]+`)|(\{\{<[^>]*>\}\})|(<!--.*?-->)|(\\cursor\b)|(\\[a-zA-Z]+)|(\$[^$\s][^$]*\$)|(\*\*[^*]+\*\*)|((?<![\w*])\*[^*\s][^*]*\*)|(!?\[[^\]]*\]\([^)\s]*\)(?:\{[^}]*\})?)|(\[[^\]]*\]\{[^}]*\})|(<\/?[a-zA-Z][^>]*>)|(\{[.#][^}]*\})|(@(?:sec|fig|tbl|eq)-[\w-]+)|(\^\[[^\]]*\])|(\{\{[\w:-]+\}\})/g;
// La punteggiatura del markdown (**, [](), `) si vede appena: in primo piano
// restano le parole. Ogni carattere resta al suo posto, cambia solo il colore.
const mkWrap = (n, cls) => s => tok('mk', s.slice(0, n)) + tok(cls, s.slice(n, s.length - n)) + tok('mk', s.slice(s.length - n));
const linkTok = s => {
  const m = s.match(/^(!?\[)([^\]]*)(\]\([^)]*\))(\{[^}]*\})?$/);
  return m ? tok('mk', m[1]) + tok('link', m[2]) + tok('url', m[3]) + tok('attr', m[4]) : tok('link', s);
};
const spanTok = s => {
  const m = s.match(/^(\[)([^\]]*)(\]\{[^}]*\})$/);
  return m ? tok('mk', m[1]) + tok('span', m[2]) + tok('attr', m[3]) : tok('link', s);
};
const MD_CLASSES = [mkWrap(1, 'code'), 'short', 'com', 'cursor', 'cmd', 'math', mkWrap(2, 'b'), mkWrap(1, 'em'), linkTok, spanTok, 'tag', 'attr', 'xref', 'fn', 'short'];
const hlInline = s => tokenize(s, MD_INLINE, MD_CLASSES);

const YAML_VAL = /("(?:[^"\\]|\\.)*"|'[^']*')|\b(true|false|null|yes|no)\b|((?<![\w.-])-?\d+(?:\.\d+)?(?![\w.-]))|(\{\{[\w:-]+\}\})|(#[0-9a-fA-F]{3,8}\b)/g;
function hlYaml(L) {
  if (/^\s*#/.test(L)) return tok('com', L);
  const val = v => {
    const cm = v.match(/^(.*?)(\s+#.*)$/);
    return tokenize(cm ? cm[1] : v, YAML_VAL, ['str', 'bool', 'num', 'short', 'num']) + (cm ? tok('com', cm[2]) : '');
  };
  let m = L.match(/^(\s*)(-\s+)?([\w.-]+)(\s*:)(.*)$/);
  if (m) return esc(m[1]) + tok('li', m[2]) + tok('key', m[3]) + esc(m[4]) + val(m[5]);
  m = L.match(/^(\s*)(-\s+)(.*)$/);
  if (m) return esc(m[1]) + tok('li', m[2]) + val(m[3]);
  return val(L);
}

function hlMd(L, i, st) {
  if (st.pre) {
    if (/^%/.test(L)) { st.cls = 'fm'; return tok('com', L); }   // intestazione dei template
    if (L.trim() === '') return '';
    st.pre = false;
    if (L.trim() === '---') { st.front = true; st.cls = 'fm fm-first'; return tok('fm', L); }
  }
  if (st.front) {
    if (L.trim() === '---') { st.front = false; st.cls = 'fm fm-last'; return tok('fm', L); }
    st.cls = 'fm';
    return hlYaml(L);
  }
  if (st.comment) {
    const end = L.indexOf('-->');
    if (end < 0) return tok('com', L);
    st.comment = false;
    return tok('com', L.slice(0, end + 3)) + hlInline(L.slice(end + 3));
  }
  if (/^\s*(```|~~~)/.test(L)) { st.fence = !st.fence; st.cls = 'cb'; return tok('fence', L); }
  if (st.fence) { st.cls = 'cb'; return tok('code', L); }
  if (/^\s*\$\$/.test(L)) { st.math = !/^\s*\$\$.*\$\$/.test(L) && !st.math; return tok('math', L); }
  if (st.math) return tok('math', L);
  let m = L.match(/^(#{1,6}\s)(.*?)(\s*\{[^}]*\}\s*)?$/);
  if (m) return tok('hmark', m[1]) + `<span class="t-h">${hlInline(m[2])}</span>` + tok('attr', m[3]);
  m = L.match(/^(\s*:{3,})(.*)$/);
  if (m) return tok('div', m[1]) + tok('attr', m[2]);
  m = L.match(/^(\s*>)(.*)$/);
  if (m) return tok('li', m[1]) + `<span class="t-quote">${hlInline(m[2])}</span>`;
  m = L.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/);
  if (m) return esc(m[1]) + tok('li', m[2]) + esc(m[3]) + hlInline(m[4]);
  if (L.includes('<!--') && !L.includes('-->')) {
    const at = L.indexOf('<!--');
    st.comment = true;
    return hlInline(L.slice(0, at)) + tok('com', L.slice(at));
  }
  return hlInline(L);
}

const hexTok = s => `<span class="t-hex" style="--c:${s}">${esc(s)}</span>`;
const CSS_RE = /(\/\*.*?\*\/)|(\/\*.*$)|(\/\/.*$)|(\$[\w-]+)|(--[\w-]+)|(#[0-9a-fA-F]{3,8}\b)|("[^"]*"|'[^']*')|(@[\w-]+)|((?<![\w#-])-?\d*\.?\d+(?:px|rem|em|%|vw|vh|s|ms|fr|deg)?\b)|(!important)|([\w-]+)(?=\s*:(?!:)[^{;]*(?:;|$))/g;
// In CSS "//" non e' un commento (url(https://...)): stessa regex senza quel ramo.
const CSS_RE_PLAIN = new RegExp(CSS_RE.source.replace('|(\\/\\/.*$)', '|(\\uFFFF\\uFFFE)'), 'g');
function hlCss(L, st, scss) {
  let head = '';
  if (st.comment) {
    const end = L.indexOf('*/');
    if (end < 0) return tok('com', L);
    st.comment = false;
    head = tok('com', L.slice(0, end + 2));
    L = L.slice(end + 2);
  }
  const classes = ['com', s => { st.comment = true; return tok('com', s); }, 'com', 'var', 'var', hexTok, 'str', 'at', 'num', 'imp', 'prop'];
  return head + tokenize(L, scss ? CSS_RE : CSS_RE_PLAIN, classes);
}

const HTML_RE = /(<!--.*?-->)|(<\/?[\w-]+)|([\w:-]+)(?==)|("[^"]*"|'[^']*')|(\/?>)/g;
function hlHtml(L, st) {
  if (st.comment) {
    const end = L.indexOf('-->');
    if (end < 0) return tok('com', L);
    st.comment = false;
    return tok('com', L.slice(0, end + 3)) + hlHtml(L.slice(end + 3), st);
  }
  if (/^\s*\/\//.test(L)) return tok('com', L);
  if (L.includes('<!--') && !L.includes('-->')) { st.comment = true; return tok('com', L); }
  return tokenize(L, HTML_RE, ['com', 'tag', 'attr', 'str', 'tag']);
}

function hlTex(L, st) {
  if (/^\s*%/.test(L)) return tok('com', L);
  if (/^\\newcommand/.test(L)) { st.body = true; return tokenize(L, /(\\newcommand)|(\\[a-zA-Z]+)|(\{[^}\\]*\})/g, ['cmd', 'key', 'str']); }
  if (/^\\endcommand/.test(L)) { st.body = false; return tok('cmd', L); }
  return st.body ? hlInline(L) : tok('com', L);
}

function highlight(text, kind) {
  const st = { pre: true };
  const lines = text.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let html;
    st.cls = '';
    if (kind === 'md') html = hlMd(L, i, st);
    else if (kind === 'yml') html = hlYaml(L);
    else if (kind === 'scss') html = hlCss(L, st, true);
    else if (kind === 'css') html = hlCss(L, st, false);
    else if (kind === 'html') html = hlHtml(L, st);
    else if (kind === 'tex') html = hlTex(L, st);
    else html = esc(L);
    out += st.cls ? `<div class="l ${st.cls}">${html}</div>` : `<div class="l">${html}</div>`;
  }
  return out;
}

// ------------------------------------------------------------------- editor

let curLineEl = null;
function refresh() {
  hl.innerHTML = highlight(ta.value, kindOf(state.current?.path));
  fitTextarea();
  curLineEl = null;
  updateDirty();
  updateCursor();
  scheduleOutline();
}
const fitTextarea = () => { ta.style.height = hl.offsetHeight + 'px'; };

function setText(text) {
  ta.value = text;
  refresh();
}

function lineOf(text, pos) {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function updateCursor() {
  if (state.view !== 'code') return;
  const pos = ta.selectionStart, text = ta.value;
  const line = lineOf(text, pos);
  const col = pos - (text.lastIndexOf('\n', pos - 1) + 1);
  $('#cursorPos').textContent = `Rg ${line + 1}, Col ${col + 1}`;
  const el = hl.children[line];
  if (curLineEl !== el) {
    curLineEl?.classList.remove('cur');
    if (document.activeElement === ta) el?.classList.add('cur');
    curLineEl = el;
  }
  markOutline(line);
}

function caretRect(pos) {
  const text = ta.value;
  const div = hl.children[lineOf(text, pos)];
  let col = pos - (text.lastIndexOf('\n', pos - 1) + 1);
  if (!div) return ta.getBoundingClientRect();
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node, lastNode = null;
  while ((node = walker.nextNode())) {
    if (!node.length) continue;
    if (col < node.length) {
      range.setStart(node, col); range.setEnd(node, col + 1);
      const r = range.getClientRects()[0];
      if (r) return { left: r.left, top: r.top, bottom: r.bottom };
    }
    col -= node.length;
    lastNode = node;
  }
  if (lastNode) {
    range.setStart(lastNode, lastNode.length - 1); range.setEnd(lastNode, lastNode.length);
    const rects = range.getClientRects();
    const r = rects[rects.length - 1];
    if (r) return { left: r.right, top: r.top, bottom: r.bottom };
  }
  const r = div.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.top + (parseFloat(getComputedStyle(hl).lineHeight) || 22) };
}

function ensureCaretVisible() {
  const r = caretRect(ta.selectionEnd);
  const box = codeScroll.getBoundingClientRect();
  if (r.bottom > box.bottom - 24) codeScroll.scrollTop += r.bottom - box.bottom + 70;
  else if (r.top < box.top + 8) codeScroll.scrollTop -= box.top - r.top + 50;
}

function insert(text, start = ta.selectionStart, end = ta.selectionEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  // execCommand tiene viva la cronologia di ⌘Z; setRangeText e' il ripiego.
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, start, end, 'end');
  refresh();
}

function indentLines(outdent) {
  const text = ta.value;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e && !outdent) return insert('  ');
  const ls = text.lastIndexOf('\n', s - 1) + 1;
  const block = text.slice(ls, e);
  const changed = block.split('\n').map(l => (outdent ? l.replace(/^ {1,2}/, '') : '  ' + l)).join('\n');
  insert(changed, ls, e);
  const delta = changed.length - block.length;
  ta.setSelectionRange(s === e ? Math.max(ls, s + delta) : ls, e + delta);
  updateCursor();
}

function wrapSelection(before, after = before) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  insert(before + sel + after, s, e);
  ta.setSelectionRange(s + before.length, s + before.length + sel.length);
}

// Titoli, elenchi e citazioni si applicano all'inizio delle righe selezionate;
// ripremere lo stesso bottone li toglie.
function prefixLines(prefix) {
  const text = ta.value;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const ls = text.lastIndexOf('\n', s - 1) + 1;
  let le = text.indexOf('\n', e);
  if (le < 0) le = text.length;
  const lines = text.slice(ls, le).split('\n');
  const strip = l => l.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/, '');
  const numbered = prefix === '1. ';
  const has = l => (numbered ? /^\d+\.\s/.test(l) : l.startsWith(prefix));
  const remove = lines.every(has);
  const out = lines.map((l, i) => (remove ? strip(l) : (numbered ? `${i + 1}. ` : prefix) + strip(l))).join('\n');
  insert(out, ls, le);
  ta.setSelectionRange(ls + out.length, ls + out.length);
  updateCursor();
}

let autoTimer;
ta.addEventListener('input', () => {
  refresh();
  maybePopup();
  requestAnimationFrame(ensureCaretVisible);
  if (state.auto) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { if (isDirty()) compile(); }, 1500);
  }
});
ta.addEventListener('click', () => { hidePopup(); updateCursor(); });
ta.addEventListener('keyup', e => { if (!popup.open || !['ArrowUp', 'ArrowDown'].includes(e.key)) updateCursor(); });
ta.addEventListener('focus', updateCursor);
ta.addEventListener('blur', () => { setTimeout(hidePopup, 120); curLineEl?.classList.remove('cur'); curLineEl = null; });
codeScroll.addEventListener('scroll', () => { if (popup.open) positionPopup(); });
new ResizeObserver(() => { if (state.view === 'code') fitTextarea(); }).observe(codeScroll);

ta.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (popup.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      popup.index = (popup.index + (e.key === 'ArrowDown' ? 1 : -1) + popup.items.length) % popup.items.length;
      renderPopup();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptCommand(popup.items[popup.index]); return; }
    if (e.key === 'Escape') { e.preventDefault(); hidePopup(); return; }
  }
  const md = kindOf(state.current?.path) === 'md';
  if (mod && md && e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSelection('**'); return; }
  if (mod && md && e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSelection('*'); return; }
  if (e.key === 'Tab' && !mod) { e.preventDefault(); indentLines(e.shiftKey); return; }
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
    const s = ta.selectionStart;
    const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
    const line = ta.value.slice(ls, s);
    const indent = line.match(/^\s*/)[0];
    const li = md && line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/);
    if (li && li[4] === '') { e.preventDefault(); insert(indent, ls, s); return; }
    const marker = li ? (/\d/.test(li[2]) ? `${parseInt(li[2], 10) + 1}.` : li[2]) + li[3] : '';
    if (indent || marker) { e.preventDefault(); insert('\n' + indent + marker); requestAnimationFrame(ensureCaretVisible); }
    return;
  }
  if (e.key.startsWith('Arrow') || e.key === 'PageDown' || e.key === 'PageUp') requestAnimationFrame(() => { updateCursor(); ensureCaretVisible(); });
});

// ------------------------------------------------------------------ immagini

const isImage = f => f && /^image\//.test(f.type);
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

async function uploadImages(files) {
  if (!isMd()) { toast('Le immagini si inseriscono nei file .qmd e .md: aprine uno', 'warn'); return; }
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) { toast(`${file.name}: oltre 15 MB`, 'error'); continue; }
    const data = await new Promise((ok, ko) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result).split(',')[1]);
      fr.onerror = ko;
      fr.readAsDataURL(file);
    });
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const name = file.name && !/^image\.\w+$/.test(file.name) ? file.name : `immagine-${new Date().toISOString().slice(0, 19).replace(/\D/g, '')}.${ext}`;
    try {
      const r = await api.post('/api/upload', { doc: state.current.path, name, data });
      const s = ta.selectionStart;
      const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
      const pre = ta.value.slice(ls, s).trim() ? '\n\n' : '';
      insert(`${pre}![](${r.path})\n`, s, ta.selectionEnd);
      const caret = s + pre.length + 2;
      ta.setSelectionRange(caret, caret);
      updateCursor();
      toast(`Salvata in ${r.file}. Scrivi la didascalia tra le parentesi quadre.`, 'info', 5000);
    } catch (e) {
      toast('Immagine non caricata: ' + e.message, 'error', 6000);
    }
  }
}

codeScroll.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); codeScroll.classList.add('drop'); } });
codeScroll.addEventListener('dragleave', e => { if (!codeScroll.contains(e.relatedTarget)) codeScroll.classList.remove('drop'); });
codeScroll.addEventListener('drop', e => {
  codeScroll.classList.remove('drop');
  if (!hasFiles(e)) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter(isImage);
  if (files.length) uploadImages(files); else toast('Qui si trascinano solo immagini', 'warn');
});
ta.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])].filter(isImage);
  if (files.length) { e.preventDefault(); uploadImages(files); }
});
// Un file lasciato cadere fuori dall'editor non deve far navigare via la pagina.
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });
$('#imgInput').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; ta.focus(); uploadImages(files); });

// ------------------------------------------------------------ barra strumenti

const LINE_PREFIX = { section: '## ', subsection: '### ', itemize: '- ', enumerate: '1. ', quote: '> ' };
const TOOLBAR = [
  ['section', 'H2', 'Titolo di sezione', 'tb-h'], ['subsection', 'H3', 'Sottosezione', 'tb-h'], null,
  ['textbf', 'B', 'Grassetto  ⌘B', 'tb-bold'], ['emph', 'I', 'Corsivo  ⌘I', 'tb-italic'], ['texttt', '{ }', 'Codice in linea', 'tb-mono'], null,
  ['href', 'Link', 'Link'], ['@image', 'Immagine', 'Immagine: scegli un file, oppure trascinala o incollala nel testo'], null,
  ['itemize', '• Elenco', 'Elenco puntato'], ['enumerate', '1. Elenco', 'Elenco numerato'], ['quote', '❝', 'Citazione'], ['equation', '∑', 'Equazione numerata'], null,
];
const BLOCKS = ['hero', 'sectionrule', 'projectcard', 'callout', 'columns', 'marginpar', 'widefigure', 'readinglist', 'tabular', 'lstlisting', 'embed', 'includegraphics', 'stack', 'tag', 'morelink', 'footnote'];

function renderToolbar() {
  const bar = $('#toolbar');
  bar.hidden = !isMd();
  // Nei .qmd e .md si scrive prosa: carattere piu' grande e colonna di lettura.
  $('#paneEditor').classList.toggle('prose', !bar.hidden);
  if (bar.hidden) return;
  const names = new Set(state.commands.map(c => c.name));
  const stop = e => e.preventDefault();   // il clic non deve togliere il fuoco al testo
  const items = [];
  for (const t of TOOLBAR) {
    if (!t) { items.push(h('span', { class: 'tb-sep' })); continue; }
    const [name, label, desc, cls] = t;
    if (!name.startsWith('@') && !names.has(name)) continue;
    items.push(h('button', { class: 'tb' + (cls ? ' ' + cls : ''), text: label, title: name.startsWith('@') ? desc : `${desc}   \\${name}`, onmousedown: stop, onclick: () => runTool(name) }));
  }
  items.push(h('button', { class: 'tb tb-menu', id: 'blocksBtn', text: 'Blocchi ▾', title: 'Blocchi del sito: apertura, schede, riquadri, colonne…', onmousedown: stop, onclick: e => toggleBlocksMenu(e.currentTarget) }));
  items.push(h('span', { class: 'spacer' }));
  items.push(h('button', { class: 'tb tb-sync', text: 'Anteprima →', title: 'Porta l\'anteprima al punto dove stai scrivendo (⌘J). Il contrario: doppio click sulla pagina.', onmousedown: stop, onclick: revealInPreview }));
  bar.replaceChildren(...items);
}

function runTool(name) {
  if (name === '@image') { $('#imgInput').click(); return; }
  if (LINE_PREFIX[name]) { prefixLines(LINE_PREFIX[name]); return; }
  acceptCommand(state.commands.find(c => c.name === name), ta.selectionStart, ta.selectionEnd, true);
}

function toggleBlocksMenu(btn) {
  const menu = $('#blocksMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  const item = c => h('button', {
    class: 'menu-item', onmousedown: e => e.preventDefault(),
    onclick: () => { menu.hidden = true; acceptCommand(c, ta.selectionStart, ta.selectionEnd, true); },
  }, [h('code', { text: '\\' + c.name }), h('span', { text: c.description })]);
  const blocks = BLOCKS.map(n => state.commands.find(c => c.name === n)).filter(Boolean);
  const inBar = new Set(TOOLBAR.filter(Boolean).map(t => t[0]));
  const others = state.commands.filter(c => !BLOCKS.includes(c.name) && !inBar.has(c.name));
  menu.replaceChildren(...[
    h('div', { class: 'menu-sep', text: 'Blocchi del sito' }), ...blocks.map(item),
    others.length ? h('div', { class: 'menu-sep', text: 'Altri comandi' }) : null, ...others.map(item),
    h('div', { class: 'menu-foot', text: 'Sono i comandi di _editor/comandi.tex: aggiungi lì i tuoi.' }),
  ].filter(Boolean));
  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = r.bottom + 4 + 'px';
}
document.addEventListener('mousedown', e => {
  const m = $('#blocksMenu');
  if (!m.hidden && !m.contains(e.target) && e.target.id !== 'blocksBtn') m.hidden = true;
});

// -------------------------------------------------------------- comandi "\"

const popup = { open: false, items: [], index: 0, start: 0, end: 0 };

function matchCommands(q) {
  q = q.toLowerCase();
  const starts = state.commands.filter(c => c.name.toLowerCase().startsWith(q));
  const rest = q ? state.commands.filter(c => !starts.includes(c) && (c.name + ' ' + c.description).toLowerCase().includes(q)) : [];
  return starts.concat(rest);
}

function maybePopup() {
  if (kindOf(state.current?.path) !== 'md' || ta.selectionStart !== ta.selectionEnd) return hidePopup();
  const s = ta.selectionStart;
  const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
  const before = ta.value.slice(ls, s);
  const m = before.match(/\\([A-Za-z]*)$/);
  if (!m) return hidePopup();
  // Dentro $...$ la barra e' matematica, non un comando.
  if (((before.slice(0, -m[0].length).match(/(?<!\\)\$/g) || []).length) % 2 === 1) return hidePopup();
  const items = matchCommands(m[1]);
  if (!items.length) return hidePopup();
  Object.assign(popup, { open: true, items, index: 0, start: s - m[0].length, end: s });
  renderPopup();
}

function renderPopup() {
  const el = $('#cmdPopup');
  el.replaceChildren(...popup.items.map((c, i) => h('div', {
    class: 'pop-item' + (i === popup.index ? ' on' : ''),
    onmousedown: ev => { ev.preventDefault(); acceptCommand(c); },
  }, [h('code', { text: '\\' + c.name }), h('span', { text: c.description })])));
  el.hidden = false;
  positionPopup();
  el.children[popup.index]?.scrollIntoView({ block: 'nearest' });
}

function positionPopup() {
  const el = $('#cmdPopup');
  const r = caretRect(popup.start);
  const x = Math.max(8, Math.min(r.left - 8, innerWidth - el.offsetWidth - 8));
  let y = r.bottom + 4;
  if (y + el.offsetHeight > innerHeight - 8) y = r.top - el.offsetHeight - 4;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function hidePopup() { popup.open = false; $('#cmdPopup').hidden = true; }

function acceptCommand(cmd, start = popup.start, end = popup.end, wrapSel = false) {
  if (!cmd) return;
  hidePopup();
  const marker = '\\cursor';
  let body = cmd.body;
  const sel = wrapSel ? ta.value.slice(start, end) : '';
  const at = body.indexOf(marker);
  body = at >= 0 ? body.slice(0, at) + sel + body.slice(at + marker.length).split(marker).join('') : body;
  const ls = ta.value.lastIndexOf('\n', start - 1) + 1;
  const prefix = body.includes('\n') && ta.value.slice(ls, start).trim() !== '' ? '\n\n' : '';
  insert(prefix + body, start, end);
  const caret = start + prefix.length + (at >= 0 ? at + sel.length : body.length);
  ta.setSelectionRange(caret, caret);
  updateCursor();
  ensureCaretVisible();
}

async function loadCommands() {
  try { state.commands = (await api.get('/api/commands')).commands; } catch { state.commands = []; }
  const help = $('#helpCommands');
  const pick = ['section', 'projectcard', 'callout', 'columns', 'equation', 'includegraphics', 'hero'];
  help.replaceChildren(...pick.map(n => state.commands.find(c => c.name === n)).filter(Boolean)
    .map(c => h('tr', {}, [h('td', {}, [h('code', { text: '\\' + c.name })]), h('td', { text: c.description })])));
}

// ---------------------------------------------------------------- struttura

let outlineTimer;
function scheduleOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(renderOutline, 250); }

function outlineItems(text, kind) {
  const items = [];
  const lines = text.split('\n');
  let fence = false, front = false;
  lines.forEach((L, i) => {
    if (kind === 'md') {
      if (i === 0 && L.trim() === '---') { front = true; return; }
      if (front) {
        if (L.trim() === '---') front = false;
        const t = L.match(/^(?:page)?title:\s*["']?(.*?)["']?\s*$/);
        if (t && t[1]) items.push({ lv: 0, text: t[1], line: i });
        return;
      }
      if (/^\s*(```|~~~)/.test(L)) { fence = !fence; return; }
      if (fence) return;
      const hd = L.match(/^(#{1,6})\s+(.*?)(\s*\{[^}]*\})?\s*$/);
      if (hd) items.push({ lv: hd[1].length, text: hd[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]/g, ''), line: i });
      if (/^:{3,}\s*\{\.section-rule\}/.test(L) && lines[i + 1]) items.push({ lv: 1, text: '§ ' + lines[i + 1], line: i });
    } else if (kind === 'css' || kind === 'scss') {
      const c = L.match(/^\/\*\s*-{2,}\s*(.*?)\s*-{2,}/) || L.match(/^\/\*--\s*(scss:\w+)\s*--\*\//);
      if (c) items.push({ lv: 1, text: c[1], line: i });
    } else if (kind === 'yml') {
      const k = L.match(/^([\w-]+):/) || L.match(/^( {2})([\w-]+):\s*$/);
      if (k) items.push({ lv: k.length === 3 ? 2 : 1, text: k[k.length - 1], line: i });
    } else if (kind === 'tex') {
      const s = L.match(/^%\s*-{3}\s*(.*?)\s*-{3,}/);
      if (s) items.push({ lv: 1, text: s[1], line: i });
      const c = L.match(/^\\newcommand\{\\(\w+)\}/);
      if (c) items.push({ lv: 2, text: '\\' + c[1], line: i });
    }
  });
  return items;
}

function renderOutline() {
  const el = $('#outline');
  if (state.view === 'layout') {
    el.replaceChildren(...LAYOUT_TABS.map(([id, label]) => h('button', {
      class: 'out-item' + (state.layoutTab === id ? ' on' : ''), style: '--lv:0', text: label, onclick: () => setLayoutTab(id),
    })));
    return;
  }
  if (state.view !== 'code') { el.replaceChildren(h('div', { class: 'out-empty', text: '—' })); return; }
  const items = outlineItems(ta.value, kindOf(state.current.path));
  if (!items.length) { el.replaceChildren(h('div', { class: 'out-empty', text: 'Nessun titolo' })); return; }
  el.replaceChildren(...items.map(it => h('button', {
    class: `out-item lv${it.lv}`, style: `--lv:${Math.max(0, it.lv - 1)}`, 'data-line': it.line, text: it.text, title: it.text,
    onclick: () => gotoLine(it.line),
  })));
  markOutline(lineOf(ta.value, ta.selectionStart));
}

function markOutline(line) {
  let on = null;
  for (const b of $$('#outline .out-item[data-line]')) if (+b.dataset.line <= line) on = b;
  $$('#outline .out-item.on').forEach(b => b !== on && b.classList.remove('on'));
  on?.classList.add('on');
}

function gotoLine(line) {
  const lines = ta.value.split('\n');
  const pos = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(pos, pos);
  const div = hl.children[line];
  if (div) codeScroll.scrollTo({ top: div.offsetTop - 80, behavior: 'smooth' });
  updateCursor();
}

function flashLine(line) {
  const div = hl.children[line];
  if (!div) return;
  div.classList.remove('flash');
  void div.offsetWidth;
  div.classList.add('flash');
}

function updateWordCount() {
  if (!isMd()) { $('#wordCount').textContent = ''; return; }
  const body = ta.value.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const n = (body.match(/[\p{L}\p{N}]+/gu) || []).length;
  $('#wordCount').textContent = `${n.toLocaleString('it-IT')} parole`;
}

// ------------------------------------------------------------------- file

const GROUPS = [
  ['pages', 'Pagine', t => t.id.includes('pagina')],
  ['posts', 'Post', t => t.target.startsWith('posts/')],
  ['projects', 'Progetti', t => t.target.startsWith('projects/')],
  ['notebooks', 'Notebook'],
  ['style', 'Stile'],
  ['settings', 'Impostazioni'],
  ['editor', 'Comandi e template'],
  ['notes', 'Note'],
];
const FILE_LABELS = {
  'index.qmd': 'Home', 'theme-light.scss': 'Tema chiaro', 'theme-dark.scss': 'Tema scuro', 'styles.css': 'Stili (CSS)',
  '_quarto.yml': 'Impostazioni del sito', 'posts/_metadata.yml': 'Default dei post', '_quarto-editor.yml': 'Profilo dell\'anteprima',
  '_editor/comandi.tex': 'Comandi \\', 'posts/_templates/post.md': 'Template di Obsidian', 'README.md': 'README', '_TODO.md': 'Cose da fare',
  'assets/color-scheme.html': 'Script del tema scuro', 'posts/_notebooks/README.md': 'Notebook nei post',
};

function fileLabel(f) {
  if (!f) return '';
  if (FILE_LABELS[f.path]) return FILE_LABELS[f.path];
  if (f.path.startsWith('_editor/templates/')) return 'Template: ' + f.path.split('/').pop().replace(/^\d+-/, '').replace(/\.\w+$/, '').replace(/-/g, ' ');
  return f.title || f.path.split('/').pop();
}

function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  if (!m) return '';
  const date = new Date(+m[1], +m[2] - 1, +m[3]);
  return date.getFullYear() === new Date().getFullYear()
    ? date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
    : date.toLocaleDateString('it-IT', { month: 'short', year: 'numeric' });
}

async function loadTree() {
  state.files = (await api.get('/api/tree')).files;
  renderTree();
}

function renderTree() {
  const q = state.filter.trim().toLowerCase();
  const rows = [h('button', { class: 'file-row special' + (state.view === 'layout' ? ' active' : ''), onclick: openLayout }, [
    h('span', { class: 'sw' }, [h('i'), h('i'), h('i')]), h('span', { class: 'name', text: 'Layout e temi' }),
    layoutDirty() ? h('span', { class: 'dot', text: '●' }) : null,
  ])];
  for (const [g, title, tplMatch] of GROUPS) {
    let files = state.files.filter(f => f.group === g);
    if (q) files = files.filter(f => (fileLabel(f) + ' ' + f.path).toLowerCase().includes(q));
    if (!files.length) continue;
    if (['posts', 'projects', 'notebooks'].includes(g)) files.sort((a, b) => (b.date || '').localeCompare(a.date || '') || fileLabel(a).localeCompare(fileLabel(b)));
    else files.sort((a, b) => (a.path === 'index.qmd' ? -1 : b.path === 'index.qmd' ? 1 : fileLabel(a).localeCompare(fileLabel(b))));
    const open = !!q || !state.collapsed.has(g);
    rows.push(h('div', { class: 'group-row', role: 'button', tabindex: 0, onclick: () => toggleGroup(g), onkeydown: e => { if (e.key === 'Enter') toggleGroup(g); } }, [
      h('span', { class: 'caret', text: open ? '▼' : '▶' }), h('span', { text: title }), h('span', { class: 'count', text: files.length }),
      tplMatch ? h('button', { class: 'add', text: '+', title: `Nuovo in ${title}`, onclick: e => { e.stopPropagation(); openNew(tplMatch); } }) : null,
    ]));
    if (!open) continue;
    for (const f of files) {
      const active = state.view !== 'layout' && state.current?.path === f.path;
      const ext = f.path.split('.').pop();
      const technical = ['style', 'settings', 'editor', 'notes'].includes(g);
      rows.push(h('button', { class: `file-row${active ? ' active' : ''}${f.editable ? '' : ' readonly'}`, title: f.path, onclick: () => openFile(f.path) }, [
        h('span', { class: 'name', text: fileLabel(f) }),
        f.draft ? h('span', { class: 'pill pill-draft', text: 'bozza' }) : null,
        technical ? h('span', { class: 'kind', text: ext }) : null,
        f.date && ['posts', 'projects', 'notebooks'].includes(g) ? h('span', { class: 'date', text: fmtDate(f.date) }) : null,
        active && isDirty() ? h('span', { class: 'dot', text: '●' }) : null,
      ]));
    }
  }
  if (rows.length === 1 && q) rows.push(h('div', { class: 'tree-empty', text: 'Nessun file con questo nome' }));
  $('#tree').replaceChildren(...rows);
  updateSwatch();
}

function toggleGroup(g) {
  state.collapsed.has(g) ? state.collapsed.delete(g) : state.collapsed.add(g);
  store.set('collapsed', [...state.collapsed]);
  renderTree();
}

$('#treeFilter').addEventListener('input', e => { state.filter = e.target.value; renderTree(); });

function showView(v) {
  state.view = v;
  codeScroll.hidden = v !== 'code';
  $('#layoutView').hidden = v !== 'layout';
  $('#emptyView').hidden = v !== 'empty';
  $('#statusHint').hidden = v !== 'code';
  $('#blocksMenu').hidden = true;
  hidePopup();
  renderToolbar();
}

function isDirty() {
  return !!(state.current?.editable && state.view === 'code' && ta.value !== state.current.saved);
}

let saveStateTimer;
function setSaveState(kind, text) {
  const el = $('#saveState');
  clearTimeout(saveStateTimer);
  el.className = 'save-state' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
  if (kind === 'ok') saveStateTimer = setTimeout(() => setSaveState(null), 2500);
}

function updateDirty() {
  const d = isDirty();
  if (d) setSaveState('dirty', '● Non salvato · ⌘S');
  else if ($('#saveState').classList.contains('dirty')) setSaveState(null);
  if (d !== state.lastDirty) { state.lastDirty = d; renderTree(); }
  updateWordCount();
  updatePreviewStatus();
}

// Intestazione: sezione › titolo, piu' "bozza" o "sola lettura". Il percorso
// del file sta nel tooltip, per chi lo cerca.
function updateHeader() {
  const crumbs = $('#filePath');
  if (state.view === 'layout') {
    crumbs.replaceChildren(h('span', { class: 'grp', text: 'Sito' }), h('span', { class: 'sep', text: '›' }), h('b', { text: 'Layout e temi' }));
    crumbs.title = '_quarto.yml, theme-light.scss, theme-dark.scss, styles.css';
  } else if (state.current) {
    const f = state.files.find(x => x.path === state.current.path);
    const group = GROUPS.find(([g]) => g === f?.group)?.[1];
    crumbs.replaceChildren(...[
      group ? h('span', { class: 'grp', text: group }) : null,
      group ? h('span', { class: 'sep', text: '›' }) : null,
      h('b', { text: fileLabel(f) || state.current.path.split('/').pop() }),
      f?.draft ? h('span', { class: 'pill pill-draft', text: 'bozza', title: 'Non va online finché nel frontmatter c\'è draft: true' }) : null,
      f && !f.editable ? h('span', { class: 'pill', text: 'sola lettura' }) : null,
    ].filter(Boolean));
    crumbs.title = state.current.path;
  }
  setSaveState(null);
  $('#cursorPos').textContent = '';
}

async function openFile(path, { line } = {}) {
  if (isDirty() && !(await save({ silent: true }))) return;
  if (state.viewMode === 'preview') setViewMode('split');
  let f;
  try { f = await api.get('/api/file?path=' + enc(path)); } catch (e) { toast(`Non riesco ad aprire ${path}: ${e.message}`, 'error'); return; }
  state.current = { path, mtime: f.mtime, editable: f.editable, saved: f.content ?? '' };
  store.set('lastFile', path);
  state.recent = [path, ...state.recent.filter(p => p !== path)].slice(0, 8);
  store.set('recent', state.recent);
  const group = state.files.find(x => x.path === path)?.group;
  if (group && state.collapsed.has(group)) { state.collapsed.delete(group); store.set('collapsed', [...state.collapsed]); }
  if (f.editable) {
    showView('code');
    setText(f.content);
    ta.setSelectionRange(0, 0);
    codeScroll.scrollTop = 0;
    if (line != null) gotoLine(line); else ta.focus({ preventScroll: true });
  } else {
    showView('empty');
    $('#emptyView').replaceChildren(
      h('h2', { text: 'Notebook: qui solo anteprima' }),
      h('p', { html: 'I notebook si scrivono ed eseguono nel loro progetto (per ISLP <code>~/Desktop/Projects/ML/notebooks/</code>) e poi si ricopiano qui. Quarto non li riesegue: pubblica gli output salvati nel file. A destra vedi la pagina che ne esce.' }),
    );
  }
  state.lastDirty = false;
  updateHeader();
  renderTree();
  renderOutline();
  updateWordCount();
  updateCursor();
  const page = pageFor(path);
  if (page && page !== state.previewPage) loadPreview(page);
  else updateEditChip();
}

async function save({ silent = false, force = false } = {}) {
  const cur = state.current;
  if (!cur?.editable || state.view !== 'code') return true;
  const content = ta.value;
  if (content === cur.saved && !force) return true;
  try {
    const r = await api.post('/api/save', { path: cur.path, content, mtime: cur.mtime, force });
    cur.mtime = r.mtime;
    cur.saved = content;
    state.needsCompile = true;
    updateDirty();
    if (!silent) setSaveState('ok', '✓ Salvato');
    afterSave(cur.path);
    return true;
  } catch (e) {
    if (e.status === 409) {
      const overwrite = confirm(`${cur.path} è cambiato sul disco mentre era aperto qui (Obsidian?).\n\nOK: tieni la versione dell'editor e sovrascrivi.\nAnnulla: carica la versione del disco.`);
      if (overwrite) return save({ silent, force: true });
      cur.mtime = e.data.mtime;
      cur.saved = e.data.content;
      setText(e.data.content);
      return false;
    }
    toast('Salvataggio non riuscito: ' + e.message, 'error', 6000);
    return false;
  }
}

function afterSave(path) {
  if (path === '_editor/comandi.tex') loadCommands().then(() => { renderToolbar(); toast(`Comandi ricaricati: ${state.commands.length}`); });
  if (['_quarto.yml', 'theme-light.scss', 'theme-dark.scss', 'styles.css'].includes(path) && !layoutDirty()) state.layout = null;
  if (kindOf(path) === 'md') loadTree().then(updateHeader).catch(() => {});
}

async function checkExternalChanges() {
  loadTree().catch(() => {});
  const cur = state.current;
  if (!cur?.editable || state.view !== 'code') return;
  try {
    const m = await api.get('/api/file?meta=1&path=' + enc(cur.path));
    if (m.mtime === cur.mtime) return;
    if (isDirty()) { toast(`${cur.path} è cambiato anche sul disco: al salvataggio ti chiedo quale tenere`, 'warn', 6000); return; }
    const f = await api.get('/api/file?path=' + enc(cur.path));
    const pos = ta.selectionStart, top = codeScroll.scrollTop;
    cur.mtime = f.mtime;
    cur.saved = f.content;
    setText(f.content);
    ta.setSelectionRange(Math.min(pos, f.content.length), Math.min(pos, f.content.length));
    codeScroll.scrollTop = top;
    toast(`Ricaricato ${cur.path}: modificato fuori dall'editor`);
  } catch { /* file sparito o server giu': non e' il momento di disturbare */ }
}

// ---------------------------------------------------------------- anteprima

function pageFor(path) {
  if (!/\.(qmd|md|ipynb)$/.test(path || '')) return null;
  if (path.split('/').some(p => p.startsWith('_') || p.startsWith('.')) || /^README\.md$/i.test(path)) return null;
  return path.replace(/\.(qmd|md|ipynb)$/, '.html');
}

// Quarto riscrive i link in forma di cartella (posts/x/ invece di
// posts/x/index.html): qui si torna sempre al nome del file.
function pageFromUrl(href) {
  const path = decodeURIComponent(new URL(href, location.href).pathname).replace(/^\/site\//, '');
  return !path || path.endsWith('/') ? path + 'index.html' : path;
}

function sourceFor(page) {
  const stem = page.replace(/\.html$/, '');
  return ['qmd', 'md', 'ipynb'].map(e => `${stem}.${e}`).find(p => state.files.some(f => f.path === p));
}

let pendingScroll = 0, pendingReveal = false;
const frameReady = f => {
  try { return f.contentDocument?.readyState === 'complete' && f.contentWindow.location.pathname.startsWith('/site/'); } catch { return false; }
};

function loadPreview(page, { keepScroll = false } = {}) {
  const url = '/site/' + page;
  if (keepScroll && page === state.previewPage && frameReady(frame)) {
    // Stessa pagina, ricaricata: si prepara dietro le quinte e si scambia.
    try { pendingScroll = frame.contentWindow.scrollY || 0; } catch { pendingScroll = 0; }
    spare.dataset.swap = '1';
    spare.src = url;
    return;
  }
  delete spare.dataset.swap;
  pendingScroll = 0;
  state.previewPage = page;
  frame.src = url;
}

function onFrameLoad(e) {
  const f = e.currentTarget;
  if (f !== spare) { if (f === frame) afterFrameLoad(); return; }
  if (spare.dataset.swap !== '1') return;
  delete spare.dataset.swap;
  try { spare.contentWindow.scrollTo(0, pendingScroll); } catch { /* niente */ }
  pendingScroll = 0;
  requestAnimationFrame(() => {
    [frame, spare] = [spare, frame];
    frame.classList.add('on');
    spare.classList.remove('on');
    afterFrameLoad();
  });
}
$$('#frameBox iframe').forEach(f => f.addEventListener('load', onFrameLoad));

function afterFrameLoad() {
  let doc;
  try { doc = frame.contentDocument; } catch { return; }
  if (!doc || !frame.contentWindow.location.pathname.startsWith('/site/')) return;
  const page = pageFromUrl(frame.contentWindow.location.href);
  state.previewPage = page;
  const src = sourceFor(page);
  const label = $('#previewPath');
  label.textContent = src ? fileLabel(state.files.find(x => x.path === src)) : '/' + page;
  label.title = '/' + page;
  $('#openExternal').href = '/site/' + page;
  doc.addEventListener('dblclick', onPreviewDblClick);
  updateEditChip();
  applyLiveCss();
  if (pendingReveal) { pendingReveal = false; setTimeout(revealInPreview, 80); }
}

// "Modifica questa pagina" solo se l'anteprima mostra una pagina diversa da
// quella aperta a sinistra (per esempio dopo aver cliccato un link).
function updateEditChip() {
  const src = sourceFor(state.previewPage);
  const btn = $('#editThisPage');
  btn.hidden = !src || (state.view !== 'layout' && src === state.current?.path);
  btn.onclick = () => src && openFile(src);
}

// La pastiglia in alto a destra dell'anteprima: dice se quello che vedi e'
// aggiornato, se sta compilando, se qualcosa e' andato storto.
let pvTimer;
function setPvStatus(kind, text, action) {
  const el = $('#pvStatus');
  clearTimeout(pvTimer);
  if (!kind) { el.hidden = true; el.className = 'pv-status'; return; }
  el.className = 'pv-status ' + kind;
  el.replaceChildren(...[kind === 'busy' ? h('span', { class: 'spin' }) : null, h('span', { text }), action ? h('b', { text: action }) : null].filter(Boolean));
  el.title = kind === 'stale' ? 'Clic per aggiornare' : kind === 'error' ? 'Clic per aprire il log' : '';
  el.hidden = false;
  if (kind === 'ok') pvTimer = setTimeout(() => setPvStatus(null), 2200);
}

function updatePreviewStatus() {
  const el = $('#pvStatus');
  if (state.compiling || el.classList.contains('error') || el.classList.contains('busy')) return;
  if (isDirty() || state.needsCompile) setPvStatus('stale', 'Non aggiornata', '⌘S');
  else if (layoutDirty()) setPvStatus('stale', 'Anteprima indicativa', 'Applica');
  else if (el.classList.contains('stale')) setPvStatus(null);
}

$('#pvStatus').addEventListener('click', () => {
  const el = $('#pvStatus');
  if (el.classList.contains('error')) setLog(true);
  else if (el.classList.contains('stale')) (state.view === 'layout' && layoutDirty() ? applyLayout() : compile());
});

function previewDark() {
  try { return frame.contentDocument.body.classList.contains('quarto-dark'); } catch { return false; }
}

function setPreviewScheme(mode) {
  if ((mode === 'dark') === previewDark()) return;
  const win = frame.contentWindow;
  if (win?.quartoToggleColorScheme) {
    win.quartoToggleColorScheme();
    setTimeout(() => { applyLiveCss(); liveUpdaters.forEach(fn => fn()); }, 60);
  }
}

$('#themeToggle').addEventListener('click', () => {
  setPreviewScheme(previewDark() ? 'light' : 'dark');
  if (state.view === 'layout' && state.layoutTab === 'colori') setTimeout(() => { state.colorMode = previewDark() ? 'dark' : 'light'; renderLayout(); }, 80);
});
$('#reloadPreview').addEventListener('click', () => loadPreview(state.previewPage, { keepScroll: true }));

// Il sito e' disegnato per 1280 px: in un riquadro da 600 px mostrerebbe la
// versione da telefono. Qui lo si impagina largo e lo si rimpicciolisce, come
// il PDF di Overleaf "adattato alla larghezza".
const DEVICE_W = { desktop: 1280, tablet: 820, phone: 390 };
function fitPreview() {
  const stage = $('#stage'), box = $('#frameBox');
  const boxed = state.device !== 'desktop';
  const fit = state.zoom === 'fit';
  const pad = boxed ? 28 : 0;
  const sw = Math.max(120, stage.clientWidth - pad), sh = Math.max(120, stage.clientHeight - pad);
  const W = !boxed && !fit ? sw : DEVICE_W[state.device];
  const s = fit ? Math.min(1, sw / W) : 1;
  for (const f of $$('#frameBox iframe')) {
    f.style.width = W + 'px';
    f.style.height = sh / s + 'px';
    f.style.transform = s < 1 ? `scale(${s})` : '';
  }
  box.style.width = W * s + 'px';
  box.style.height = sh + 'px';
  stage.classList.toggle('boxed', boxed);
  $$('#deviceSeg button').forEach(b => b.classList.toggle('on', b.dataset.dev === state.device));
  const zb = $('#zoomBtn');
  zb.textContent = fit ? `${Math.round(s * 100)}%` : '100%';
  zb.title = fit
    ? `Adattato: la pagina è impaginata a ${W} px e rimpicciolita per starci. Clic per la dimensione reale.`
    : 'Dimensione reale. Clic per adattare la pagina al riquadro.';
}
new ResizeObserver(fitPreview).observe($('#stage'));
$('#deviceSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.device = b.dataset.dev;
  store.set('previewDevice', state.device);
  fitPreview();
});
$('#zoomBtn').addEventListener('click', () => {
  state.zoom = state.zoom === 'fit' ? 'real' : 'fit';
  store.set('previewZoom', state.zoom);
  fitPreview();
});

// --- Anteprima <-> sorgente, alla SyncTeX ----------------------------------------
// Pandoc trasforma il testo (virgolette curve, trattini lunghi, markup): si
// confrontano versioni "normalizzate" delle due parti, prima parola per parola.

const normText = s => (s || '').replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/---|--|—|–/g, '-')
  .replace(/[*_`#>\\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const stripMd = l => l.replace(/!?\[([^\]]*)\]\([^)]*\)(\{[^}]*\})?/g, '$1').replace(/\[([^\]]*)\]\{[^}]*\}/g, '$1')
  .replace(/\{[.#][^}]*\}/g, '').replace(/<[^>]+>/g, ' ').replace(/^\s*([-*+]|\d+\.)\s+/, '').replace(/&amp;/g, '&');
const frontEnd = lines => (lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1);

function findSourceLine(text) {
  const lines = ta.value.split('\n');
  const fm = frontEnd(lines);
  const plain = lines.map((l, i) => (i <= fm ? '' : normText(stripMd(l))));
  const words = normText(text).split(' ').filter(Boolean);
  for (let k = Math.min(8, words.length); k >= 1; k--) {
    const probe = words.slice(0, k).join(' ');
    if (probe.length < 5) break;
    const i = plain.findIndex(l => l.includes(probe));
    if (i >= 0) return i;
  }
  const t = normText(text).slice(0, 24);
  return t ? lines.findIndex((l, i) => i <= fm && /^(page)?title:/.test(l) && normText(l).includes(t)) : -1;
}

async function onPreviewDblClick(ev) {
  const target = ev.target;
  try { frame.contentWindow.getSelection()?.removeAllRanges(); } catch { /* niente */ }
  // Una voce di un elenco (home, Writing) porta al post, non alla pagina che lo elenca.
  const item = target.closest?.('.quarto-post, .quarto-grid-item, .list-group-item');
  const link = item?.querySelector('a[href]');
  if (link) {
    const src = sourceFor(pageFromUrl(new URL(link.getAttribute('data-original-href') || link.getAttribute('href'), frame.contentWindow.location.href).href));
    if (src) { openFile(src); return; }
  }
  const el = target.closest?.('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, pre, dt, dd, .hero-meta, .section-rule, .stack, .subtitle, .description');
  if (!el) return;
  const src = sourceFor(state.previewPage);
  if (!src) { toast('Questa pagina non ha un sorgente da aprire', 'warn'); return; }
  if (state.current?.path !== src) await openFile(src);
  if (state.view !== 'code') return;
  const line = findSourceLine(el.innerText);
  if (line >= 0) { gotoLine(line); flashLine(line); }
  else toast('Questo testo non sta nel sorgente della pagina: forse viene da _quarto.yml o da un elenco', 'warn', 5000);
}

function revealInPreview() {
  if (state.view !== 'code') return;
  if (state.viewMode === 'write') setViewMode('split');
  const page = pageFor(state.current.path);
  if (!page) { toast('Questo file non diventa una pagina del sito', 'warn'); return; }
  if (page !== state.previewPage) { pendingReveal = true; loadPreview(page); return; }
  let doc;
  try { doc = frame.contentDocument; } catch { return; }
  if (!doc) return;
  const lines = ta.value.split('\n');
  const fm = frontEnd(lines);
  const line = lineOf(ta.value, ta.selectionStart);
  if (line <= fm) { const t = doc.querySelector('#title-block-header, main h1'); if (t) scrollFlash(t); return; }
  const cands = [...doc.querySelectorAll('main p, main li, main h1, main h2, main h3, main h4, main h5, main h6, main td, main th, main blockquote, main figcaption, main pre, main .stack, main .hero-meta, main .section-rule')];
  for (let i = line; i > fm && i >= line - 40; i--) {
    if (/^\s*(:::|```|~~~|\$\$)/.test(lines[i])) continue;
    const words = normText(stripMd(lines[i])).split(' ').filter(Boolean);
    const probe = words.slice(0, 6).join(' ');
    if (probe.length < 5) continue;
    const el = cands.find(e => normText(e.innerText).includes(probe));
    if (el) { scrollFlash(el); return; }
  }
  toast('Non trovo questo punto nell\'anteprima: compila e riprova', 'warn');
}

function scrollFlash(el) {
  const doc = el.ownerDocument;
  if (!doc.getElementById('editor-flash-style')) {
    const st = doc.createElement('style');
    st.id = 'editor-flash-style';
    st.textContent = '@keyframes editorFlash{0%,35%{background-color:rgba(224,138,90,.28);box-shadow:0 0 0 8px rgba(224,138,90,.28)}100%{background-color:transparent;box-shadow:0 0 0 8px transparent}}.editor-flash{animation:editorFlash 1.8s ease-out;border-radius:3px}';
    doc.head.append(st);
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('editor-flash');
  void el.offsetWidth;
  el.classList.add('editor-flash');
}

// ------------------------------------------------------------- compilazione

async function compile() {
  if (state.view === 'code' && !(await save())) return;
  if (state.compiling) { state.compileAgain = true; return; }
  state.compiling = true;
  $('#btnCompile').classList.add('compiling');
  $('.compile-label').textContent = 'Compilo…';
  $('#progress').hidden = false;
  setPvStatus('busy', 'Compilo…');
  try {
    const r = await api.post('/api/render');
    showLog(r);
    $('#firstBuild').hidden = true;
    if (r.ok) {
      state.needsCompile = false;
      loadPreview(state.previewPage, { keepScroll: true });
      setPvStatus('ok', `✓ Aggiornata in ${r.seconds} s`);
    } else {
      setPvStatus('error', '✗ Compilazione fallita', 'Apri il log');
    }
    if (!state.layout) loadLayout().then(updateSwatch).catch(() => {});
  } catch (e) {
    setPvStatus('error', '✗ Il server dell\'editor non risponde');
    toast('Compilazione non partita: ' + e.message, 'error', 6000);
  } finally {
    state.compiling = false;
    $('#btnCompile').classList.remove('compiling');
    $('.compile-label').textContent = 'Compila';
    $('#progress').hidden = true;
    if (state.compileAgain) { state.compileAgain = false; compile(); }
    else updatePreviewStatus();
  }
}

function showLog(r) {
  const problems = r.problems || [];
  const errors = problems.filter(p => /ERROR/.test(p));
  const time = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const sum = $('#logSummary');
  if (!r.ok) sum.innerHTML = `<b class="err">✗ Compilazione fallita</b> · ${errors.length || problems.length || 1} errori · ${time}`;
  else if (problems.length) sum.innerHTML = `<b class="warn">⚠ Compilato con ${problems.length} avvisi</b> · ${r.seconds} s · ${time}`;
  else sum.innerHTML = `<b class="ok">✓ Compilato</b> · ${r.seconds} s · ${time}`;
  const known = new Set(state.files.map(f => f.path));
  const lines = r.log.split('\n');
  const probEls = problems.map(p => {
    const idx = lines.findIndex(l => l.trim() === p);
    const context = lines.slice(Math.max(0, idx - 3), idx + 4).join('\n');
    const file = [...known].find(k => context.includes(k));
    const lineNo = context.match(/line (\d+)/i);
    const el = h('span', { class: 'problem' + (/ERROR/.test(p) ? ' err' : '') }, [p]);
    if (file) el.append('  ', h('a', { text: `→ ${file}${lineNo ? ':' + lineNo[1] : ''}`, onclick: () => openFile(file, { line: lineNo ? +lineNo[1] - 1 : undefined }) }));
    return el;
  });
  $('#logBody').replaceChildren(...probEls, h('div', { class: 'raw', text: r.log.trim() }));
  if (!r.ok) setLog(true);
}

function setLog(open) {
  $('#logBody').hidden = !open;
  $('#logCaret').textContent = open ? '▾' : '▴';
}
$('#logToggle').addEventListener('click', () => setLog($('#logBody').hidden));

// ------------------------------------------------------------------ layout

const LAYOUT_TABS = [['temi', 'Temi'], ['colori', 'Colori'], ['caratteri', 'Caratteri'], ['menu', 'Menu'], ['pagina', 'Pagina'], ['sito', 'Sito']];
const COLOR_KEYS = ['paper', 'ink', 'ink-muted', 'accent', 'accent-soft', 'rule', 'surface', 'code-color'];
const COLOR_INFO = {
  paper: ['Sfondo', 'Il fondo di tutte le pagine'],
  ink: ['Testo', 'Paragrafi e titoli'],
  'ink-muted': ['Testo secondario', 'Date, descrizioni, didascalie'],
  accent: ['Accento', 'Link, voce attiva, bordi al passaggio del mouse'],
  'accent-soft': ['Accento tenue', 'Evidenziazioni leggere'],
  rule: ['Filetti', 'Linee di separazione e bordi delle schede'],
  surface: ['Superfici', 'Fondo dei blocchi di codice'],
  'code-color': ['Codice in linea', 'Il colore del codice dentro il testo'],
};
const CONTRAST_WITH = { ink: 'paper', 'ink-muted': 'paper', accent: 'paper', 'code-color': 'surface' };
const FONT_OPTS = [['$font-family-serif', 'Serif'], ['$font-family-sans-serif', 'Sans'], ['$font-family-monospace', 'Mono']];
const PRESET_TYPE = ['font-family-base', 'headings-font-family', 'font-size-root', 'line-height-base', 'headings-font-weight'];
const BOOL_PAGE = ['toc', 'code-copy', 'link-external-newwindow'];

const getIn = (o, key) => key.split('.').reduce((x, k) => x?.[k], o);
const setIn = (o, key, v) => { const ks = key.split('.'); const last = ks.pop(); ks.reduce((x, k) => (x[k] ??= {}), o)[last] = v; };
let liveUpdaters = [];
let layoutDirtyShown = false;

async function loadLayout() {
  const L = await api.get('/api/layout');
  for (const k of BOOL_PAGE) if (L.page[k] != null) L.page[k] = L.page[k] === 'true';
  state.layout = L;
  state.layoutSaved = structuredClone(L);
}

async function loadPresets() {
  try { state.presets = (await api.get('/api/presets')).presets; } catch { state.presets = []; }
}

function layoutDirty() {
  return !!state.layout && JSON.stringify(state.layout) !== JSON.stringify(state.layoutSaved);
}

function countChanges(a = state.layout, b = state.layoutSaved) {
  let n = 0;
  for (const k of Object.keys(a || {})) {
    const x = a[k], y = b?.[k];
    if (x && typeof x === 'object' && !Array.isArray(x)) n += countChanges(x, y || {});
    else if (JSON.stringify(x) !== JSON.stringify(y)) n++;
  }
  return n;
}

function layoutChanged() {
  applyLiveCss();
  liveUpdaters.forEach(fn => fn());
  const n = state.layout ? countChanges() : 0;
  $('#btnLayout').classList.toggle('has-dot', n > 0);
  const bar = $('#lvBar');
  if (bar) {
    bar.hidden = n === 0;
    bar.querySelector('.lv-count').textContent = n === 1 ? '1 modifica non applicata' : `${n} modifiche non applicate`;
  }
  updateSwatch();
  if ((n > 0) !== layoutDirtyShown) { layoutDirtyShown = n > 0; renderTree(); }
  updatePreviewStatus();
}

function updateSwatch() {
  const c = state.layout?.light;
  if (!c) return;
  for (const sw of $$('.sw')) [c.paper, c.accent, c.ink].forEach((v, i) => { if (sw.children[i]) sw.children[i].style.background = v; });
}

async function openLayout() {
  if (isDirty() && !(await save({ silent: true }))) return;
  if (state.viewMode === 'preview') setViewMode('split');
  try {
    if (!state.layout) await loadLayout();
    if (!state.presets.length) await loadPresets();
  } catch (e) { toast('Non riesco a leggere il layout: ' + e.message, 'error', 6000); return; }
  showView('layout');
  renderLayout();
  updateHeader();
  renderTree();
  renderOutline();
  updateWordCount();
  updateEditChip();
}

function setLayoutTab(id) {
  state.layoutTab = id;
  store.set('layoutTab', id);
  renderLayout();
  $('#layoutView').scrollTop = 0;
  renderOutline();
}

function renderLayout() {
  const view = $('#layoutView');
  const top = view.scrollTop;
  liveUpdaters = [];
  const render = { temi: tabTemi, colori: tabColori, caratteri: tabCaratteri, menu: tabMenu, pagina: tabPagina, sito: tabSito }[state.layoutTab] || tabTemi;
  view.replaceChildren(
    h('div', { class: 'lv-head' }, [
      h('div', { class: 'lv-title' }, [h('h1', { text: 'Layout e temi' }), h('span', { class: 'muted', text: 'Cambi qui, guardi a destra. Applica scrive i file.' })]),
      h('nav', { class: 'tabs' }, LAYOUT_TABS.map(([id, label]) => h('button', { class: 'tab' + (state.layoutTab === id ? ' on' : ''), text: label, onclick: () => setLayoutTab(id) }))),
    ]),
    h('div', { class: 'lv-body' }, render()),
    h('div', { class: 'lv-bar', id: 'lvBar', hidden: true }, [
      h('span', { class: 'lv-dot', text: '●' }), h('span', { class: 'lv-count' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', text: 'Annulla', onclick: resetLayout }),
      h('button', { class: 'btn btn-compile', onclick: applyLayout }, ['Applica e compila', h('kbd', { text: '⌘S' })]),
    ]),
  );
  view.scrollTop = top;
  layoutChanged();
}

// --- controlli ----------------------------------------------------------------------

function field(label, control, hint) {
  return h('label', { class: 'field' }, [h('span', { class: 'field-label', text: label }), control, hint ? h('small', { class: 'hint', text: hint }) : null]);
}
const MISSING = 'Valore non trovato nel file sorgente.';

function textField(key, label, hint, mono) {
  const v = getIn(state.layout, key);
  const input = h('input', { type: 'text', class: mono ? 'mono' : null, value: v ?? '', disabled: v == null, spellcheck: 'false' });
  input.addEventListener('input', () => { setIn(state.layout, key, input.value); layoutChanged(); });
  return field(label, input, v == null ? MISSING : hint);
}

function rangeField(key, label, min, max, step, unit, hint) {
  const raw = getIn(state.layout, key);
  const num = parseFloat(raw);
  const out = h('output', { text: raw ?? '—' });
  const input = h('input', { type: 'range', min, max, step, value: Number.isNaN(num) ? min : num, disabled: raw == null });
  input.addEventListener('input', () => { const v = input.value + unit; setIn(state.layout, key, v); out.textContent = v; layoutChanged(); });
  return field(label, h('div', { class: 'range' }, [input, out]), raw == null ? MISSING : hint);
}

function selectField(key, label, options, hint) {
  const v = getIn(state.layout, key);
  const opts = options.some(([val]) => val === v) || v == null ? options : [...options, [v, v]];
  const sel = h('select', { disabled: v == null }, opts.map(([val, text]) => h('option', { value: val, selected: val === v, text })));
  sel.addEventListener('change', () => { setIn(state.layout, key, sel.value); layoutChanged(); });
  return field(label, sel, v == null ? MISSING : hint);
}

function boolField(key, label, hint) {
  const v = getIn(state.layout, key);
  const box = h('input', { type: 'checkbox', class: 'toggle', checked: v === true, disabled: v == null });
  box.addEventListener('change', () => { setIn(state.layout, key, box.checked); layoutChanged(); });
  return field(label, box, v == null ? MISSING : hint);
}

function stackOf(v, T = state.layout.type) {
  return { '$font-family-serif': T['font-family-serif'], '$font-family-sans-serif': T['font-family-sans-serif'], '$font-family-monospace': T['font-family-monospace'] }[v] || v;
}

function luminance(hex) {
  const v = to6(hex).slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) {
  try { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); } catch { return NaN; }
}
const to6 = v => (/^#[0-9a-f]{3}$/i.test(v) ? '#' + [...v.slice(1)].map(c => c + c).join('') : String(v).slice(0, 7));

// --- Temi -------------------------------------------------------------------------------

function presetMatches(p, L) {
  if (!L) return false;
  const same = (want, have) => Object.entries(want || {}).every(([k, v]) => String(have?.[k]).toLowerCase() === String(v).toLowerCase());
  return same(p.light, L.light) && same(p.dark, L.dark) && same(p.type, L.type) && same(p.css, L.css);
}

function mockHalf(c, T, css) {
  return h('div', { class: 'mock-half', style: `background:${c.paper};color:${c.ink}` }, [
    h('div', { class: 'mock-nav', style: `border-color:${c.rule}` }, [h('i', { style: `background:${c.ink}` }), h('i', { style: `background:${c['ink-muted']}` }), h('i', { style: `background:${c.accent}` })]),
    h('div', { class: 'mock-h', style: `font-family:${stackOf(T['headings-font-family'])};font-weight:${T['headings-font-weight']}`, text: 'Aa' }),
    h('div', { class: 'mock-p', style: `font-family:${stackOf(T['font-family-base'])}` }, ['Il naive ', h('span', { style: `color:${c.accent};text-decoration:underline`, text: 'vince' })]),
    h('div', { class: 'mock-code', style: `background:${c.surface};color:${c['code-color']};border-radius:${css.radius}`, text: 'fit()' }),
  ]);
}

function themeCard(p) {
  const L = state.layout;
  const T = { ...L.type, ...p.type }, css = { ...L.css, ...p.css };
  const selected = presetMatches(p, L), inUse = presetMatches(p, state.layoutSaved);
  return h('button', { class: 'theme-card' + (selected ? ' on' : ''), onclick: () => applyPreset(p) }, [
    h('div', { class: 'mock' }, [mockHalf({ ...L.light, ...p.light }, T, css), mockHalf({ ...L.dark, ...p.dark }, T, css)]),
    h('div', { class: 'theme-meta' }, [
      h('div', { class: 'theme-name' }, [h('strong', { text: p.nome }), inUse ? h('span', { class: 'pill pill-ok', text: 'in uso' }) : selected ? h('span', { class: 'pill', text: 'in anteprima' }) : null]),
      h('span', { class: 'muted', text: p.descrizione || '' }),
    ]),
  ]);
}

function newThemeCard() {
  const card = h('div', { class: 'theme-card theme-new' });
  const form = () => {
    const name = h('input', { type: 'text', placeholder: 'Nome del tema' });
    const desc = h('input', { type: 'text', placeholder: 'Una riga di descrizione (facoltativa)' });
    const saveIt = async () => {
      if (!name.value.trim()) { name.focus(); return; }
      const L = state.layout;
      try {
        const r = await api.post('/api/presets', { nome: name.value, descrizione: desc.value, light: L.light, dark: L.dark, type: Object.fromEntries(PRESET_TYPE.map(k => [k, L.type[k]])), css: L.css });
        await loadPresets();
        renderLayout();
        toast(`Tema «${r.preset.nome}» salvato in _editor/temi.json`);
      } catch (e) { toast(e.message, 'error'); }
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') saveIt(); });
    card.replaceChildren(h('div', { class: 'theme-form' }, [
      h('strong', { text: 'Salva l\'aspetto attuale' }), name, desc,
      h('div', { class: 'row' }, [h('button', { class: 'btn', text: 'Annulla', onclick: idle }), h('button', { class: 'btn btn-compile', text: 'Salva tema', onclick: saveIt })]),
    ]));
    name.focus();
  };
  const idle = () => card.replaceChildren(h('button', { class: 'theme-new-btn', onclick: form }, [
    h('span', { class: 'plus', text: '+' }), h('strong', { text: 'Salva l\'aspetto attuale come tema' }),
    h('span', { class: 'muted', text: 'Colori, caratteri e misure di adesso, da ritrovare qui quando vuoi.' }),
  ]));
  idle();
  return card;
}

function applyPreset(p) {
  for (const mode of ['light', 'dark']) Object.assign(state.layout[mode], p[mode]);
  Object.assign(state.layout.type, p.type);
  Object.assign(state.layout.css, p.css);
  renderLayout();
  toast(`«${p.nome}» in anteprima. Applica per tenerlo, Annulla per tornare indietro.`);
}

function tabTemi() {
  return [
    h('p', { class: 'lv-intro', text: 'Un tema imposta insieme colori chiari e scuri, caratteri e misure. Sceglilo, guardalo a destra, poi ritocca nelle altre schede.' }),
    h('div', { class: 'theme-grid' }, [...state.presets.map(themeCard), newThemeCard()]),
  ];
}

// --- Colori -----------------------------------------------------------------------------

function colorRow(mode, k) {
  const key = `${mode}.${k}`;
  const v = getIn(state.layout, key);
  const [label, hint] = COLOR_INFO[k];
  const text = h('div', { class: 'color-text' }, [h('strong', { text: label }), h('small', { class: 'hint', text: hint })]);
  if (v == null || !/^#[0-9a-f]{3,8}$/i.test(v)) return h('div', { class: 'color-row' }, [h('span'), text, h('span'), h('span', { class: 'muted mono', text: v ?? '—' })]);
  const pick = h('input', { type: 'color', class: 'swatch', value: to6(v), title: label });
  const hex = h('input', { type: 'text', class: 'mono hex', value: v, maxlength: 9, spellcheck: 'false' });
  const badge = h('span', { class: 'ratio' });
  const drawBadge = () => {
    const other = CONTRAST_WITH[k];
    if (!other) { badge.hidden = true; return; }
    const r = contrast(state.layout[mode][k], state.layout[mode][other]);
    badge.textContent = Number.isNaN(r) ? '' : `${r.toFixed(1)}:1`;
    badge.className = 'ratio ' + (r >= 4.5 ? 'good' : 'low');
    badge.title = r >= 4.5 ? `Contrasto con ${COLOR_INFO[other][0].toLowerCase()}: si legge bene` : 'Contrasto basso: sotto 4.5:1 si legge a fatica';
  };
  liveUpdaters.push(drawBadge);
  pick.addEventListener('input', () => { hex.value = pick.value; setIn(state.layout, key, pick.value); layoutChanged(); });
  hex.addEventListener('input', () => {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.value)) { pick.value = to6(hex.value); setIn(state.layout, key, hex.value); layoutChanged(); }
  });
  return h('div', { class: 'color-row' }, [pick, text, badge, hex]);
}

function tabColori() {
  if (!state.colorMode) state.colorMode = previewDark() ? 'dark' : 'light';
  const mode = state.colorMode;
  const sample = h('div', { class: 'color-sample' });
  liveUpdaters.push(() => {
    const c = state.layout[mode], T = state.layout.type;
    sample.setAttribute('style', `background:${c.paper};color:${c.ink};border-color:${c.rule}`);
    sample.replaceChildren(
      h('div', { class: 'cs-meta', style: `color:${c['ink-muted']};font-family:${T['font-family-sans-serif']}`, text: '18 AGO 2026 · NOTES' }),
      h('div', { class: 'cs-h', style: `font-family:${stackOf(T['headings-font-family'])};font-weight:${T['headings-font-weight']}`, text: 'The R² that means nothing' }),
      h('p', { style: `font-family:${stackOf(T['font-family-base'])}` }, ['Shuffling the rows invents a model that ', h('a', { style: `color:${c.accent}`, text: 'sees the future' }), '. Split by time with ', h('code', { style: `background:${c.surface};color:${c['code-color']}`, text: 'TimeSeriesSplit' }), '.']),
      h('div', { class: 'cs-card', style: `border-color:${c.rule};background:${c['accent-soft']}` }, [h('span', { style: `color:${c.accent}`, text: '→ ' }), 'Accento tenue, filetti e superfici']),
    );
  });
  return [
    h('div', { class: 'lv-row' }, [
      h('div', { class: 'seg seg-lg' }, [['light', '☀  Tema chiaro'], ['dark', '☾  Tema scuro']].map(([m, label]) => h('button', {
        class: m === mode ? 'on' : null, text: label,
        onclick: () => { state.colorMode = m; setPreviewScheme(m); renderLayout(); },
      }))),
      h('span', { class: 'muted small', text: 'L\'anteprima passa allo stesso tema.' }),
    ]),
    sample,
    h('div', { class: 'color-list' }, COLOR_KEYS.map(k => colorRow(mode, k))),
  ];
}

// --- Caratteri --------------------------------------------------------------------------

function fontChoice(key, label) {
  const wrap = h('div', { class: 'font-choice' });
  const draw = () => {
    const v = getIn(state.layout, key);
    wrap.replaceChildren(h('span', { class: 'field-label', text: label }), h('div', { class: 'font-opts' }, FONT_OPTS.map(([val, name]) => h('button', {
      class: 'font-opt' + (val === v ? ' on' : ''),
      onclick: () => { setIn(state.layout, key, val); layoutChanged(); draw(); },
    }, [h('span', { class: 'aa', style: `font-family:${stackOf(val)}`, text: 'Aa' }), h('span', { text: name })]))));
  };
  draw();
  return wrap;
}

function tabCaratteri() {
  const spec = h('div', { class: 'specimen' });
  liveUpdaters.push(() => {
    const T = state.layout.type, c = state.layout[previewDark() ? 'dark' : 'light'];
    spec.setAttribute('style', `background:${c.paper};color:${c.ink};border-color:${c.rule}`);
    spec.replaceChildren(
      h('div', { class: 'sp-h', style: `font-family:${stackOf(T['headings-font-family'])};font-weight:${T['headings-font-weight']}`, text: 'Forecasting from the ground up' }),
      h('p', { style: `font-family:${stackOf(T['font-family-base'])};font-size:${T['font-size-root']};line-height:${T['line-height-base']}`, text: 'Five years of Terna load data, national and regional, at hourly resolution. Rather than start with a library, I wrote the forecasting primitives by hand — baselines, error metrics, temporal splits.' }),
    );
  });
  return [
    spec,
    fontChoice('type.font-family-base', 'Testo'),
    fontChoice('type.headings-font-family', 'Titoli'),
    h('div', { class: 'fields' }, [
      rangeField('type.font-size-root', 'Corpo del testo', 14, 23, 1, 'px'),
      rangeField('type.line-height-base', 'Interlinea', 1.3, 2, 0.05, ''),
      rangeField('type.headings-font-weight', 'Peso dei titoli', 300, 800, 100, ''),
    ]),
    h('details', { class: 'advanced' }, [
      h('summary', { text: 'Famiglie di caratteri (avanzato)' }),
      h('p', { class: 'hint', text: 'Liste di font di sistema in ordine di preferenza: il browser usa il primo che trova. Il sito non scarica font da server esterni.' }),
      h('div', { class: 'fields' }, [
        textField('type.font-family-serif', 'Serif', null, true),
        textField('type.font-family-sans-serif', 'Sans-serif', null, true),
        textField('type.font-family-monospace', 'Monospazio', null, true),
      ]),
    ]),
    h('p', { class: 'hint', text: 'Uguale nei due temi: ogni modifica va sia in theme-light.scss sia in theme-dark.scss.' }),
  ];
}

// --- Menu -------------------------------------------------------------------------------

function navbarEditor() {
  const wrap = h('div');
  const pages = state.files.filter(f => pageFor(f.path));
  const draw = () => {
    const items = state.layout.navbar;
    const rows = items.map((it, i) => {
      const text = h('input', { type: 'text', value: it.text, placeholder: 'Etichetta' });
      const href = h('input', { type: 'text', class: 'mono', list: 'pagesList', value: it.href, placeholder: 'pagina.qmd', spellcheck: 'false' });
      text.addEventListener('input', () => { it.text = text.value; layoutChanged(); });
      href.addEventListener('input', () => { it.href = href.value; layoutChanged(); });
      const move = (from, to) => { const [m] = items.splice(from, 1); items.splice(to, 0, m); draw(); layoutChanged(); };
      const grip = h('span', { class: 'grip', title: 'Trascina per spostare', text: '⠿' });
      const row = h('div', { class: 'nav-row' }, [
        grip, text, href,
        h('button', { class: 'icon-btn', title: 'Sposta su', text: '↑', disabled: i === 0, onclick: () => move(i, i - 1) }),
        h('button', { class: 'icon-btn', title: 'Sposta giù', text: '↓', disabled: i === items.length - 1, onclick: () => move(i, i + 1) }),
        h('button', { class: 'icon-btn danger', title: 'Togli dal menu (la pagina resta)', text: '×', onclick: () => { items.splice(i, 1); draw(); layoutChanged(); } }),
      ]);
      grip.addEventListener('pointerdown', () => { row.draggable = true; });
      row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-nav', String(i)); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { row.draggable = false; row.classList.remove('dragging'); });
      row.addEventListener('dragover', e => {
        if (![...e.dataTransfer.types].includes('text/x-nav')) return;
        e.preventDefault();
        const r = row.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drop-before', 'drop-after');
        const from = +e.dataTransfer.getData('text/x-nav');
        const r = row.getBoundingClientRect();
        let to = e.clientY < r.top + r.height / 2 ? i : i + 1;
        if (from < to) to--;
        if (from !== to) move(from, to);
      });
      return row;
    });
    const inMenu = new Set(items.map(x => x.href));
    const free = pages.filter(f => !inMenu.has(f.path));
    const main = free.filter(f => f.group === 'pages'), other = free.filter(f => f.group !== 'pages');
    const opt = f => h('option', { value: f.path, text: `${fileLabel(f)}  ·  ${f.path}` });
    const add = h('select', { class: 'add-page' }, [
      h('option', { value: '', text: '+ Aggiungi al menu…' }),
      main.length ? h('optgroup', { label: 'Pagine' }, main.map(opt)) : null,
      other.length ? h('optgroup', { label: 'Altre pagine' }, other.map(opt)) : null,
      h('option', { value: '@', text: 'Link libero (indirizzo o percorso)' }),
    ]);
    add.addEventListener('change', () => {
      if (!add.value) return;
      const f = pages.find(p => p.path === add.value);
      items.push(f ? { text: fileLabel(f), href: f.path } : { text: '', href: '' });
      draw();
      layoutChanged();
      if (!f) wrap.querySelectorAll('.nav-row input')[items.length * 2 - 2]?.focus();
    });
    wrap.replaceChildren(
      h('datalist', { id: 'pagesList' }, pages.map(f => h('option', { value: f.path }))),
      h('div', { class: 'nav-editor' }, rows),
      add,
    );
  };
  draw();
  return wrap;
}

function tabMenu() {
  const mock = h('div', { class: 'nav-mock' });
  liveUpdaters.push(() => {
    const L = state.layout, c = L[previewDark() ? 'dark' : 'light'];
    mock.setAttribute('style', `background:${c.paper};color:${c.ink};border-color:${c.rule};font-family:${L.type['font-family-sans-serif']}`);
    mock.replaceChildren(h('strong', { text: L.site.title || '' }), h('span', { class: 'spacer' }),
      ...L.navbar.filter(i => i.text).map(i => h('span', { class: 'nm-item', style: `text-transform:${L.css['nav-case']}`, text: i.text })));
  });
  return [
    mock,
    navbarEditor(),
    h('h3', { class: 'lv-sub', text: 'Aspetto' }),
    h('div', { class: 'fields' }, [selectField('css.nav-case', 'Voci del menu', [['uppercase', 'MAIUSCOLO'], ['none', 'Come le scrivi']])]),
    h('p', { class: 'hint', text: 'Il menu vero cambia dopo Applica. Le icone a destra (GitHub, RSS) si modificano in _quarto.yml.' }),
  ];
}

// --- Pagina e Sito ----------------------------------------------------------------------

function tabPagina() {
  return [
    h('h3', { class: 'lv-sub', text: 'Impaginazione' }),
    h('div', { class: 'fields' }, [
      rangeField('css.measure', 'Larghezza della colonna', 32, 64, 1, 'rem', 'Tra 40 e 48rem le righe si leggono senza perdere il segno.'),
      rangeField('css.section-gap', 'Spazio tra le sezioni in home', 1.5, 6, 0.25, 'rem'),
      rangeField('css.radius', 'Angoli di schede e codice', 0, 12, 1, 'px'),
    ]),
    h('h3', { class: 'lv-sub', text: 'Indice e dettagli' }),
    h('div', { class: 'fields' }, [
      boolField('page.toc', 'Indice laterale', 'Vale per tutto il sito; una pagina lo cambia con toc: nel frontmatter.'),
      rangeField('page.toc-depth', 'Livelli nell\'indice', 1, 4, 1, ''),
      textField('page.toc-title', 'Titolo dell\'indice'),
      boolField('page.code-copy', 'Pulsante "copia" sul codice'),
      boolField('page.link-external-newwindow', 'Link esterni in una nuova scheda'),
    ]),
  ];
}

function tabSito() {
  return [
    h('div', { class: 'fields' }, [
      textField('site.title', 'Titolo del sito', 'In alto a sinistra nel menu e nella scheda del browser.'),
      textField('site.description', 'Descrizione', 'Per i motori di ricerca e le anteprime dei link condivisi.'),
      textField('site.footer_left', 'Piè di pagina'),
    ]),
  ];
}

function resetLayout() {
  state.layout = structuredClone(state.layoutSaved);
  renderLayout();
  loadPreview(state.previewPage, { keepScroll: true });
}

async function applyLayout() {
  try {
    const r = await api.post('/api/layout', state.layout);
    await loadLayout();
    if (state.view === 'layout') renderLayout(); else layoutChanged();
    toast(r.changed.length ? `Scritti: ${r.changed.join(', ')}` : 'Niente da scrivere: i file erano già così');
    await compile();
  } catch (e) {
    toast('Layout non salvato: ' + e.message, 'error', 7000);
  }
}

function liveCss() {
  if (!layoutDirty()) return '';
  const L = state.layout, t = L.type, c = previewDark() ? L.dark : L.light;
  return `
:root {
  --site-paper:${c.paper}; --site-ink:${c.ink}; --site-muted:${c['ink-muted']}; --site-accent:${c.accent};
  --site-accent-soft:${c['accent-soft']}; --site-rule:${c.rule}; --site-surface:${c.surface};
  --site-sans:${t['font-family-sans-serif']}; --site-mono:${t['font-family-monospace']};
  --site-measure:${L.css.measure}; --site-radius:${L.css.radius}; --site-section-gap:${L.css['section-gap']}; --site-nav-case:${L.css['nav-case']};
  --bs-body-bg:${c.paper}; --bs-body-color:${c.ink}; --bs-link-color:${c.accent}; --bs-border-color:${c.rule};
  font-size:${t['font-size-root']};
}
body, #quarto-header, #quarto-header .navbar, .nav-footer { background-color:${c.paper} !important; }
body { color:${c.ink}; font-family:${stackOf(t['font-family-base'])}; line-height:${t['line-height-base']}; }
h1, h2, h3, h4, h5, h6, .title { font-family:${stackOf(t['headings-font-family'])}; font-weight:${t['headings-font-weight']}; color:${c.ink}; }
a, .navbar .nav-link:hover, .sidebar nav[role=doc-toc] ul > li > a.active { color:${c.accent}; }
.navbar .nav-link, .navbar .navbar-title, .navbar .bi { color:${c.ink} !important; }
code { color:${c['code-color']}; }
pre, div.sourceCode, p code, pre.sourceCode { background-color:${c.surface} !important; }
.quarto-title-meta, .listing-description, .nav-footer, .sidebar nav[role=doc-toc] a { color:${c['ink-muted']}; }
hr, .border, .table, main.content h2 { border-color:${c.rule} !important; }`;
}

function applyLiveCss() {
  let doc;
  try { doc = frame.contentDocument; } catch { return; }
  if (!doc?.head) return;
  const css = liveCss();
  let st = doc.getElementById('editor-live');
  if (!css) { st?.remove(); return; }
  if (!st) { st = doc.createElement('style'); st.id = 'editor-live'; doc.head.append(st); }
  st.textContent = css;
  const title = doc.querySelector('.navbar-title');
  if (title && state.layout.site.title != null) title.textContent = state.layout.site.title;
}

// ---------------------------------------------------------------- tavolozza

const pal = { items: [], index: 0, selStart: 0, selEnd: 0 };

function openPalette(initial = '') {
  Object.assign(pal, { index: 0, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
  const input = $('#palInput');
  input.value = initial;
  filterPalette();
  $('#dlgPalette').showModal();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function filterPalette() {
  const raw = $('#palInput').value.trim();
  const onlyCommands = raw.startsWith('\\');
  const q = raw.replace(/^\\/, '').toLowerCase();
  const canInsert = isMd();
  let items = [];
  if (!onlyCommands) {
    const score = f => {
      if (!q) { const r = state.recent.indexOf(f.path); return r >= 0 ? r : 50; }
      const l = fileLabel(f).toLowerCase(), p = f.path.toLowerCase();
      return l.startsWith(q) ? 0 : l.includes(q) ? 1 : p.includes(q) ? 2 : -1;
    };
    items = state.files.map(f => [score(f), f]).filter(([s]) => s >= 0)
      .sort((a, b) => a[0] - b[0] || fileLabel(a[1]).localeCompare(fileLabel(b[1])))
      .slice(0, q ? 30 : 10)
      .map(([, f]) => ({ section: q ? 'File' : 'File recenti e pagine', label: fileLabel(f), hint: f.path, run: () => openFile(f.path) }));
  }
  if (onlyCommands || q) {
    if (canInsert) {
      items = items.concat(matchCommands(q).map(c => ({ section: 'Comandi · inserisci nel testo', label: '\\' + c.name, hint: c.description, mono: true, run: () => acceptCommand(c, pal.selStart, pal.selEnd, true) })));
    } else if (onlyCommands) {
      items.push({ section: 'Comandi', label: 'Apri un file .qmd o .md per inserire i comandi', hint: '', run: () => {} });
    }
  }
  if (!onlyCommands) {
    const actions = [
      ['Compila il sito', compile], ['Layout e temi', openLayout], ['Nuovo post, progetto o pagina', () => openNew()],
      ['Pubblica', openPublish], ['Come si usa e scorciatoie', openHelp], ['Mostra o nascondi i file', toggleSidebar],
    ];
    items = items.concat(actions.filter(([l]) => !q || l.toLowerCase().includes(q)).map(([label, run]) => ({ section: 'Azioni', label, hint: '', run })));
  }
  pal.items = items;
  pal.index = Math.min(pal.index, Math.max(0, items.length - 1));
  renderPalette();
}

function renderPalette() {
  const nodes = [];
  let sec = null;
  pal.items.forEach((it, i) => {
    if (it.section !== sec) { sec = it.section; nodes.push(h('div', { class: 'pal-sec', text: sec })); }
    nodes.push(h('div', { class: 'pal-item' + (i === pal.index ? ' on' : ''), onmousedown: e => { e.preventDefault(); runPalette(i); } }, [
      h(it.mono ? 'code' : 'span', { class: 'pal-label', text: it.label }), h('span', { class: 'pal-hint', text: it.hint }),
    ]));
  });
  if (!nodes.length) nodes.push(h('div', { class: 'pal-empty', text: 'Niente di simile' }));
  const list = $('#palList');
  list.replaceChildren(...nodes);
  list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
}

function runPalette(i) {
  const it = pal.items[i];
  $('#dlgPalette').close();
  if (it) setTimeout(it.run, 0);
}

$('#palInput').addEventListener('input', () => { pal.index = 0; filterPalette(); });
$('#palInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (pal.items.length) pal.index = (pal.index + (e.key === 'ArrowDown' ? 1 : -1) + pal.items.length) % pal.items.length;
    renderPalette();
  } else if (e.key === 'Enter') { e.preventDefault(); runPalette(pal.index); }
});
$('#dlgPalette').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// -------------------------------------------------------------------- nuovo

async function openNew(prefer) {
  try { state.templates = (await api.get('/api/templates')).templates; } catch (e) { toast(e.message, 'error'); return; }
  const last = store.get('lastTemplate', null);
  const chosen = (prefer && state.templates.find(prefer)?.id) || (state.templates.some(t => t.id === last) ? last : state.templates[0]?.id);
  $('#formNew').reset();
  $('#tplGrid').replaceChildren(...state.templates.map(t => h('label', { class: 'tpl' }, [
    h('input', { type: 'radio', name: 'template', value: t.id, checked: t.id === chosen }),
    h('span', { class: 'tpl-body' }, [h('strong', { text: t.name }), h('small', { text: t.description })]),
  ])));
  updateNewPath();
  $('#dlgNew').showModal();
  $('#newTitle').focus();
}

function updateNewPath() {
  const id = $('#formNew input[name=template]:checked')?.value;
  const t = state.templates.find(x => x.id === id);
  if (!t) return;
  const slug = slugify($('#newTitle').value || 'titolo');
  $('#newPath').textContent = t.target.replaceAll('{{slug}}', slug);
  $('#newAfter').textContent = (t.after || '').replaceAll('{{slug}}', slug);
}

$('#formNew').addEventListener('input', updateNewPath);
$('#newCancel').addEventListener('click', () => $('#dlgNew').close());
$('#formNew').addEventListener('submit', async e => {
  e.preventDefault();
  const template = $('#formNew input[name=template]:checked')?.value;
  try {
    const r = await api.post('/api/new', { template, title: $('#newTitle').value, description: $('#newDesc').value });
    store.set('lastTemplate', template);
    $('#dlgNew').close();
    await loadTree();
    await openFile(r.path);
    if (r.after) toast(r.after, 'info', 8000);
    compile();
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
});

// ----------------------------------------------------------------- pubblica

const ST_LABEL = { M: ['modificato', ''], '?': ['nuovo', 'new'], A: ['aggiunto', 'new'], D: ['eliminato', 'del'], R: ['rinominato', ''], MM: ['modificato', ''], AM: ['aggiunto', 'new'] };

async function openPublish() {
  if (state.view === 'code' && !(await save({ silent: true }))) return;
  $('#pubLog').hidden = true;
  await refreshPublish();
  $('#dlgPublish').showModal();
}

async function refreshPublish() {
  let g;
  try { g = await api.get('/api/git'); } catch (e) { toast(e.message, 'error'); return; }
  const info = $('#pubInfo'), list = $('#pubList');
  if (!g.repo) {
    info.textContent = 'Questa cartella non è una repo git.';
    list.replaceChildren();
    $('#pubCommit').disabled = $('#pubPush').disabled = true;
    return;
  }
  info.innerHTML = `Branch <code>${esc(g.branch)}</code> · ` + (g.remote
    ? 'remote <code>origin</code> pronto: dopo il push GitHub Actions ripubblica il sito in un paio di minuti.'
    : 'nessun remote ancora: puoi fare commit, il push si attiva quando colleghi la repo (README §4).');
  $('#pubCommit').disabled = !g.files.length;
  $('#pubPush').disabled = !g.files.length || !g.remote;
  $('#pubPush').title = g.remote ? '' : 'Manca il remote origin: vedi README §4';
  if (!g.files.length) { list.replaceChildren(h('div', { class: 'pub-empty', text: 'Niente da pubblicare: tutto è già in un commit.' })); return; }
  list.replaceChildren(...g.files.map(f => {
    const [label, cls] = ST_LABEL[f.status] || [f.status, ''];
    return h('label', { class: 'pub-row' }, [
      h('input', { type: 'checkbox', value: f.path, checked: f.status !== '?' }),
      h('span', { class: `pub-st ${cls}`, text: label }),
      h('code', { text: f.path }),
    ]);
  }));
}

async function doPublish(push) {
  const paths = $$('#pubList input:checked').map(i => i.value);
  const message = $('#pubMsg').value.trim();
  if (!paths.length) { toast('Spunta almeno un file', 'warn'); return; }
  if (!message) { toast('Scrivi il messaggio di commit', 'warn'); $('#pubMsg').focus(); return; }
  $('#pubCommit').disabled = $('#pubPush').disabled = true;
  try {
    const r = await api.post('/api/git/commit', { message, paths, push });
    const logEl = $('#pubLog');
    logEl.textContent = r.log;
    logEl.hidden = false;
    if (r.ok) { toast(push ? 'Push fatto: il sito si aggiorna tra un paio di minuti' : 'Commit fatto'); $('#pubMsg').value = ''; }
    else toast('Non è andata: leggi il log', 'error');
  } catch (e) {
    toast(e.message, 'error', 6000);
  }
  await refreshPublish();
}

$('#pubClose').addEventListener('click', () => $('#dlgPublish').close());
$('#pubCommit').addEventListener('click', () => doPublish(false));
$('#pubPush').addEventListener('click', () => doPublish(true));

// ------------------------------------------------------- aiuto, divisore, tasti

function openHelp() { $('#dlgHelp').showModal(); }
$('#helpClose').addEventListener('click', () => $('#dlgHelp').close());

function toggleSidebar() {
  const hidden = document.body.classList.toggle('no-sidebar');
  store.set('sidebar', !hidden);
}

// Scrivi: tutto lo spazio al testo. Anteprima: tutto al sito. Diviso: entrambi.
function setViewMode(mode) {
  state.viewMode = mode;
  store.set('viewMode', mode);
  document.body.classList.toggle('mode-write', mode === 'write');
  document.body.classList.toggle('mode-preview', mode === 'preview');
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
}
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setViewMode(b.dataset.mode); });

(function splitter() {
  const sp = $('#splitter'), ws = $('#workspace');
  const apply = frac => ws.style.setProperty('--editor-frac', frac);
  apply(store.get('split', 0.46));
  sp.addEventListener('dblclick', () => { apply(0.5); store.set('split', 0.5); });
  sp.title = 'Trascina per ridimensionare · doppio click per dividere a metà';
  sp.addEventListener('pointerdown', e => {
    sp.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const left = document.body.classList.contains('no-sidebar') ? ws.getBoundingClientRect().left : $('.sidebar').getBoundingClientRect().right;
    const width = ws.getBoundingClientRect().right - left - 6;
    const move = ev => { const f = Math.min(0.8, Math.max(0.22, (ev.clientX - left) / width)); apply(f); store.set('split', f); };
    const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); document.body.classList.remove('dragging'); };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
})();

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (!mod && e.key === '?' && !typing && !document.querySelector('dialog[open]')) { e.preventDefault(); openHelp(); return; }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's' || k === 'enter') { e.preventDefault(); state.view === 'layout' && layoutDirty() ? applyLayout() : compile(); }
  else if (k === 'p') { e.preventDefault(); openPalette(''); }
  else if (k === 'k') { e.preventDefault(); openPalette(isMd() ? '\\' : ''); }
  else if (k === 'j') { e.preventDefault(); revealInPreview(); }
  else if (e.key === '\\') { e.preventDefault(); toggleSidebar(); }
});

$('#btnCompile').addEventListener('click', () => (state.view === 'layout' && layoutDirty() ? applyLayout() : compile()));
$('#btnNew').addEventListener('click', () => openNew());
$('#btnSearch').addEventListener('click', () => openPalette(''));
$('#btnLayout').addEventListener('click', openLayout);
$('#btnPublish').addEventListener('click', openPublish);
$('#btnHelp').addEventListener('click', openHelp);
$('#btnSidebar').addEventListener('click', toggleSidebar);
$('#autoToggle').addEventListener('change', e => {
  state.auto = e.target.checked;
  store.set('auto', state.auto);
  toast(state.auto ? 'Compilazione automatica: parte da sola quando smetti di scrivere' : 'Compilazione automatica spenta: usa ⌘S');
});

window.addEventListener('focus', checkExternalChanges);
window.addEventListener('beforeunload', e => { if (isDirty() || layoutDirty()) { e.preventDefault(); e.returnValue = ''; } });

// -------------------------------------------------------------------- avvio

(async function init() {
  let st;
  try { st = await api.get('/api/status'); } catch { toast('Il server dell\'editor non risponde', 'error', 10000); return; }
  $('#siteTitle').textContent = st.title || 'Sito';
  document.title = `${st.title || 'Sito'} · editor`;
  if (!st.quarto) toast('Quarto non trovato: la compilazione non funzionerà (README §1)', 'error', 10000);
  if (store.get('sidebar', true) === false) document.body.classList.add('no-sidebar');
  $('#autoToggle').checked = state.auto;
  fitPreview();

  await Promise.all([loadTree(), loadCommands(), loadPresets(), loadLayout().catch(() => {})]);
  updateSwatch();
  const last = store.get('lastFile', 'index.qmd');
  const first = state.files.some(f => f.path === last) ? last : 'index.qmd';
  state.previewPage = pageFor(first) || 'index.html';
  if (!st.preview) $('#firstBuild').hidden = false;
  else loadPreview(state.previewPage);
  await openFile(first);
  setViewMode(state.viewMode);
  if (!store.get('helpSeen', false)) { store.set('helpSeen', true); openHelp(); }
  // Si ricompila sempre all'avvio: Obsidian o il terminale possono aver
  // cambiato i sorgenti mentre l'editor era chiuso.
  compile();
})();
