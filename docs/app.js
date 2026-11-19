/*
 * app.js — the page.
 *
 * Everything here runs against local data: dropped files are read with
 * FileReader, hashed with WebCrypto, unzipped with DecompressionStream, and
 * never sent anywhere. The UI is deliberately small: a checklist on the left,
 * the actual files on the right, and the verdict underneath. Every string
 * comes from i18n.js, so the same packet reads in English or Korean.
 */

import { readZip } from './lib/zip.js';
import { extractText, isScannable } from './lib/textract.js';
import { scanText } from './lib/scan.js';
import { evaluatePacket, MB } from './lib/rules.js';
import { sha256Hex } from './lib/hash.js';
import { buildManifest, diffManifests, describeDiff, receiptText } from './lib/manifest.js';
import { PRESETS, clonePreset } from './lib/presets.js';
import { buildSamplePacket, buildFixFiles, SAMPLE_NAME } from './lib/samples.js';
import { pickLang, UI, findingText } from './lib/i18n.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Text scanning is skipped above this size: a 30MB scanned PDF would stall the
// page, and the useful answer there is the size itself.
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

let lang = pickLang(localStorage.getItem('packetproof:lang'));
const T = () => UI[lang];
const labelText = (item) => (item.label && typeof item.label === 'object' ? item.label[lang] || item.label.en : String(item.label));

const state = {
  presetKey: 'grant',
  checklist: clonePreset('grant'),
  totalMB: 50,
  files: [],
  result: null,
  manifest: null,
  prevManifest: null,
  diff: null,
  busy: false,
};

/* ───────────────────────── language ───────────────────────── */

function applyLanguage() {
  document.documentElement.lang = lang;
  for (const el of $$('[data-i18n]')) el.textContent = T()[el.dataset.i18n] ?? '';
  for (const el of $$('[data-i18n-html]')) el.innerHTML = T()[el.dataset.i18nHtml] ?? '';
  for (const el of $$('[data-i18n-ph]')) el.placeholder = T()[el.dataset.i18nPh] ?? '';
  for (const el of $$('[data-i18n-title]')) el.title = T()[el.dataset.i18nTitle] ?? '';
  const langBtn = $('#lang-btn');
  if (langBtn) langBtn.textContent = T().langLabel;
  $('#preset-select').setAttribute('aria-label', T().step1);
  fillPresets();
  renderChecklist();
  renderFiles();
  renderVerdict();
  renderFindings();
  if (state.manifest) renderReceipt();
  updateSealHint();
}

function updateSealHint() {
  if (!state.files.length) setSealHint(T().sealHintEmpty);
  else if (state.result?.verdict === 'blocked') setSealHint(T().sealHintBlocked);
  else setSealHint(T().sealHintReady);
}

/* ───────────────────────── checklist ───────────────────────── */

function fillPresets() {
  const select = $('#preset-select');
  select.innerHTML = '';
  for (const [key, preset] of Object.entries(PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = preset.labels[lang] || preset.labels.en;
    select.append(opt);
  }
  select.value = state.presetKey;
}

function setupPresets() {
  $('#preset-select').addEventListener('change', (e) => {
    state.presetKey = e.target.value;
    state.checklist = clonePreset(e.target.value);
    state.totalMB = state.checklist.totalMB || 50;
    $('#total-mb').value = state.totalMB;
    renderChecklist();
    runChecks();
  });
}

function renderChecklist() {
  if (!state.checklist) state.checklist = clonePreset('grant');
  const body = $('#checklist-table tbody');
  body.innerHTML = '';
  state.checklist.items.forEach((item, index) => {
    const tr = document.createElement('tr');

    const tdLabel = document.createElement('td');
    const label = document.createElement('input');
    label.type = 'text';
    label.value = labelText(item);
    label.addEventListener('input', () => {
      item.label = { en: label.value, ko: label.value };
      runChecks();
    });
    tdLabel.append(label);

    const tdReq = document.createElement('td');
    tdReq.className = 'req';
    const req = document.createElement('input');
    req.type = 'checkbox';
    req.checked = !!item.required;
    req.setAttribute('aria-label', labelText(item));
    req.addEventListener('change', () => { item.required = req.checked; runChecks(); });
    tdReq.append(req);

    const tdExt = document.createElement('td');
    const ext = document.createElement('input');
    ext.type = 'text';
    ext.className = 'ext';
    ext.value = (item.extensions || []).join(',');
    ext.addEventListener('input', () => {
      item.extensions = ext.value.split(',').map((s) => s.trim().replace(/^\./, '')).filter(Boolean);
      runChecks();
    });
    tdExt.append(ext);

    const tdMax = document.createElement('td');
    const max = document.createElement('input');
    max.type = 'number';
    max.className = 'num';
    max.min = '1';
    max.value = item.maxMB || 10;
    max.setAttribute('aria-label', `${labelText(item)} MB`);
    max.addEventListener('input', () => { item.maxMB = Number(max.value) || 0; runChecks(); });
    tdMax.append(max);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.setAttribute('aria-label', `remove ${labelText(item)}`);
    del.addEventListener('click', () => {
      state.checklist.items.splice(index, 1);
      renderChecklist();
      runChecks();
    });
    tdDel.append(del);

    tr.append(tdLabel, tdReq, tdExt, tdMax, tdDel);
    body.append(tr);
  });
  $('#total-mb').value = state.totalMB;
}

function addItem() {
  state.checklist.items.push({ label: { en: 'item', ko: '항목' }, required: false, extensions: ['pdf'], keywords: [], maxMB: 10 });
  renderChecklist();
  runChecks();
}

/* ───────────────────────── files ───────────────────────── */

function renderFiles() {
  const wrap = $('#files-list');
  wrap.innerHTML = '';
  if (!state.files.length) {
    const p = document.createElement('p');
    p.className = 'file-empty';
    p.textContent = T().filesEmpty;
    wrap.append(p);
    return;
  }
  for (const file of state.files) {
    const row = document.createElement('div');
    row.className = 'file-row ' + (file.itemLabel ? 'matched' : 'unmatched');
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement('div');
    meta.className = 'fmeta';
    meta.textContent = `${formatSize(file.size)} · ${file.sha.slice(0, 8)}`;
    const tag = document.createElement('div');
    tag.className = 'ftag';
    tag.textContent = file.itemLabel || T().unmatched;
    const del = document.createElement('button');
    del.className = 'icon-btn file-del';
    del.textContent = '×';
    del.title = T().removeFile;
    del.setAttribute('aria-label', `${T().removeFile}: ${file.name}`);
    del.addEventListener('click', () => removeFile(file.name));
    row.append(name, meta, tag, del);
    wrap.append(row);
  }
}

function removeFile(name) {
  state.files = state.files.filter((f) => f.name !== name);
  state.manifest = null;
  state.diff = null;
  $('#receipt').hidden = true;
  renderFiles();
  runChecks();
}

function formatSize(bytes) {
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

async function ingestRaw(rawList) {
  if (state.busy) return;
  state.busy = true;
  setSealHint(T().loadingFiles);
  const added = [];
  try {
    for (const raw of rawList) {
      const { name, bytes } = raw;
      const isZip = /\.zip$/i.test(name) || looksLikeZip(bytes);
      if (isZip) {
        try {
          const entries = await readZip(bytes);
          for (const entry of entries) {
            if (entry.dir || entry.name.startsWith('__MACOSX/') || entry.name.endsWith('.DS_Store')) continue;
            added.push({ name: zipEntryName(name, entry.name), bytes: entry.data });
          }
          continue;
        } catch (err) {
          added.push({ name, bytes, readError: err.message, zip: true });
          continue;
        }
      }
      added.push({ name, bytes });
    }

    for (const item of added) {
      const sha = await sha256Hex(item.bytes);
      const record = {
        name: item.name,
        size: item.bytes.length,
        sha,
        text: '',
        partial: false,
        scannable: isScannable(item.name),
        scan: [],
        skippedMB: 0,
        readError: item.readError || '',
      };
      if (record.scannable && record.size > MAX_SCAN_BYTES) {
        record.skippedMB = +(record.size / MB).toFixed(1);
      } else if (record.scannable) {
        const extracted = await extractText(item.name, item.bytes);
        record.text = extracted.text || '';
        record.partial = !!extracted.partial;
        if (record.text) record.scan = scanText(record.text);
      }
      state.files.push(record);
    }
  } finally {
    state.busy = false;
    renderFiles();
    runChecks();
  }
}

function zipEntryName(zipName, entryName) {
  const stem = zipName.replace(/\.zip$/i, '');
  return entryName.includes('/') || !stem ? entryName : entryName;
}

function looksLikeZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function filesFromFileList(fileList) {
  const out = [];
  for (const file of fileList) {
    const buf = await file.arrayBuffer();
    out.push({ name: file.webkitRelativePath || file.name, bytes: new Uint8Array(buf) });
  }
  return out;
}

async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const out = [];
  const walk = async (entry, path) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      const buf = await file.arrayBuffer();
      out.push({ name: path + file.name, bytes: new Uint8Array(buf) });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      for (const child of children) await walk(child, path + entry.name + '/');
    }
  };
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) await walk(entry, '');
    else if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) out.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  if (!out.length && dataTransfer.files?.length) return filesFromFileList(dataTransfer.files);
  return out;
}

/* ───────────────────────── checks ───────────────────────── */

function runChecks() {
  const checklist = state.checklist.items.map((i) => ({ ...i, label: labelText(i) }));
  const result = evaluatePacket({
    files: state.files.map((f) => ({ name: f.name, size: f.size, sha: f.sha })),
    checklist,
    limits: { totalMB: state.totalMB },
  });
  for (const file of state.files) file.itemLabel = result.matches[file.name] || '';

  const contentFindings = [];
  for (const file of state.files) {
    for (const hit of file.scan) {
      contentFindings.push({
        severity: hit.severity,
        code: hit.code,
        file: file.name,
        line: hit.line,
        params: hit.params,
      });
    }
    if (file.readError) {
      contentFindings.push({ severity: 'note', code: 'UNREAD', file: file.name, params: { text: file.readError } });
    } else if (file.skippedMB) {
      contentFindings.push({ severity: 'note', code: 'UNREAD', file: file.name, params: { text: T().sizeSkipped(file.skippedMB) } });
    } else if (file.scannable && file.partial) {
      contentFindings.push({ severity: 'note', code: 'PARTIAL', file: file.name, params: {} });
    } else if (file.scannable && !file.text) {
      contentFindings.push({ severity: 'note', code: 'NODOC', file: file.name, params: {} });
    }
  }

  const all = [...result.findings, ...contentFindings];
  const blocking = all.filter((f) => f.severity === 'block').length;
  const warnings = all.filter((f) => f.severity === 'warn').length;
  const verdict = blocking ? 'blocked' : warnings ? 'warnings' : state.files.length ? 'ready' : 'empty';

  state.result = {
    ...result,
    findings: all,
    stats: { ...result.stats, blocking, warnings, files: state.files.length },
    verdict,
  };
  renderVerdict();
  renderFindings();
  renderFiles();
  $('#seal-btn').disabled = !state.files.length;
  updateSealHint();
}

function renderVerdict() {
  const badge = $('#verdict');
  const v = state.result?.verdict || 'empty';
  const n = v === 'warnings' ? state.result.stats.warnings : v === 'blocked' ? state.result.stats.blocking : 0;
  badge.dataset.state = v;
  badge.textContent = v === 'warnings'
    ? T().verdictWarnings(n)
    : v === 'blocked'
      ? T().verdictBlocked(n)
      : v === 'ready'
        ? T().verdictReady
        : T().verdictEmpty;
}

function renderFindings() {
  const wrap = $('#findings');
  wrap.innerHTML = '';
  const findings = (state.result?.findings || []).filter((f) => f.severity !== 'note' || f.code === 'EXTRA');
  const ordered = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  if (!ordered.length && state.files.length) {
    const ok = document.createElement('div');
    ok.className = 'all-clear';
    const strong = document.createElement('strong');
    strong.textContent = T().allClearTitle;
    const span = document.createElement('span');
    span.textContent = T().allClearBody;
    ok.append(strong, span);
    wrap.append(ok);
  } else if (!state.files.length) {
    const p = document.createElement('p');
    p.className = 'file-empty';
    p.textContent = T().allClearEmpty;
    wrap.append(p);
  }

  for (const f of ordered) {
    const row = document.createElement('div');
    row.className = `finding ${f.severity}`;
    const sev = document.createElement('div');
    sev.className = 'sev';
    sev.textContent = { block: T().severityBlock, warn: T().severityWarn, note: T().severityNote }[f.severity] || f.severity;
    const body = document.createElement('div');
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = findingText(lang, f.code, f.params || {});
    body.append(what);
    if (f.file || f.line) {
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = [f.file, f.line ? `${f.line}` : ''].filter(Boolean).join(' · ');
      body.append(where);
    }
    row.append(sev, body);
    wrap.append(row);
  }
}

const severityRank = (s) => ({ block: 0, warn: 1, note: 2 }[s] ?? 3);

/* ───────────────────────── seal ───────────────────────── */

function seal() {
  if (!state.files.length) return;
  const manifest = buildManifest({
    packet: $('#packet-name').value || PRESETS[state.presetKey]?.labels[lang] || 'untitled-packet',
    checklist: state.checklist.items.map((i) => ({ ...i, label: labelText(i) })),
    files: state.files,
    matches: state.result.matches,
    verdict: state.result.verdict,
    stats: state.result.stats,
    findings: state.result.findings,
  });

  const key = `packetproof:${manifest.packet}`;
  let previous = state.prevManifest;
  if (!previous) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) previous = JSON.parse(raw);
    } catch { /* storage may be blocked; a manifest is optional */ }
  }
  state.diff = previous ? diffManifests(previous, manifest) : null;
  state.manifest = manifest;
  try { localStorage.setItem(key, JSON.stringify(manifest)); } catch { /* ignore */ }
  renderReceipt();
}

function renderReceipt() {
  const box = $('#receipt');
  box.hidden = false;
  box.innerHTML = '';

  const head = document.createElement('h3');
  head.textContent = T().receiptTitle;
  box.append(head);

  const pre = document.createElement('pre');
  pre.id = 'receipt-text';
  pre.textContent = receiptText(state.manifest, state.diff, lang);
  box.append(pre);

  const stamp = document.createElement('div');
  stamp.className = 'stamp';
  stamp.textContent = state.manifest.verdict === 'ready'
    ? T().stampReady
    : state.manifest.verdict === 'blocked'
      ? T().stampBlocked
      : T().stampWarn;
  box.append(stamp);

  if (state.diff) {
    const diff = document.createElement('div');
    diff.className = 'diff';
    const title = document.createElement('strong');
    title.textContent = T().vsPrev;
    const ul = document.createElement('ul');
    for (const line of describeDiff(state.diff, lang)) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.append(li);
    }
    diff.append(title, ul);
    box.append(diff);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.style.marginTop = '12px';

  const dl = document.createElement('button');
  dl.className = 'btn tiny';
  dl.textContent = T().download;
  dl.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.manifest, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(state.manifest.packet)}-manifest.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const copy = document.createElement('button');
  copy.className = 'btn tiny';
  copy.textContent = T().copy;
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#receipt-text').textContent);
    copy.textContent = T().copied;
    setTimeout(() => { copy.textContent = T().copy; }, 1500);
  });

  actions.append(dl, copy);
  box.append(actions);
}

const slug = (s) => String(s).trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'packet';

/* ───────────────────────── wiring ───────────────────────── */

function setSealHint(text) {
  $('#seal-hint').textContent = text;
}

function setupDropzone() {
  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#file-input').click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); }
  });
  for (const type of ['dragenter', 'dragover']) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.add('drag'); });
  }
  for (const type of ['dragleave', 'drop']) {
    dz.addEventListener(type, () => dz.classList.remove('drag'));
  }
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    const raw = await filesFromDataTransfer(e.dataTransfer);
    await ingestRaw(raw);
  });
  $('#file-input').addEventListener('change', async (e) => {
    await ingestRaw(await filesFromFileList(e.target.files));
    e.target.value = '';
  });
  $('#folder-input').addEventListener('change', async (e) => {
    const list = [...e.target.files].filter((f) => !f.name.startsWith('.') && !f.webkitRelativePath.includes('/.'));
    await ingestRaw(await filesFromFileList(list));
    e.target.value = '';
  });
  $('#pick-files').addEventListener('click', () => $('#file-input').click());
  $('#pick-folder').addEventListener('click', () => $('#folder-input').click());
}

function setupButtons() {
  $('#seal-btn').addEventListener('click', seal);
  $('#add-item').addEventListener('click', addItem);
  $('#clear-btn').addEventListener('click', () => {
    state.files = [];
    state.manifest = null;
    state.diff = null;
    state.prevManifest = null;
    $('#receipt').hidden = true;
    renderFiles();
    runChecks();
  });
  $('#total-mb').addEventListener('input', (e) => {
    state.totalMB = Number(e.target.value) || 0;
    runChecks();
  });
  $('#sample-btn').addEventListener('click', async () => {
    state.files = [];
    renderFiles();
    setSealHint(T().buildingSample);
    const zip = await buildSamplePacket();
    await ingestRaw([{ name: SAMPLE_NAME, bytes: zip }]);
    addDemoFixButton();
    setSealHint(T().sampleHint);
  });
  $('#prev-manifest').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      state.prevManifest = JSON.parse(await file.text());
      setSealHint(T().prevLoaded(state.prevManifest.sealedAt.slice(0, 10)));
    } catch {
      setSealHint(T().readingFailed);
    }
  });
  $('#lang-btn').addEventListener('click', () => {
    lang = lang === 'en' ? 'ko' : 'en';
    try { localStorage.setItem('packetproof:lang', lang); } catch { /* ignore */ }
    applyLanguage();
    runChecks();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      seal();
    }
  });
}

function addDemoFixButton() {
  if ($('#fix-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'btn tiny';
  btn.id = 'fix-btn';
  btn.textContent = T().fixing;
  btn.addEventListener('click', async () => {
    await ingestRaw(await buildFixFiles());
    btn.remove();
  });
  document.querySelector('.row-actions.sub')?.append(btn);
}

/* ───────────────────────── boot ───────────────────────── */

function boot() {
  applyLanguage();
  setupPresets();
  renderChecklist();
  setupDropzone();
  setupButtons();
  renderFiles();
  runChecks();
  applyLanguage();
  window.__packetproof = { state, runChecks, seal, ingestRaw, removeFile, get lang() { return lang; } };
}

boot();
