/*
 * app.js — the page.
 *
 * Everything here runs against local data: dropped files are read with
 * FileReader, hashed with WebCrypto, unzipped with DecompressionStream, and
 * never sent anywhere. The UI is deliberately small: a checklist on the left,
 * the actual files on the right, and the verdict underneath.
 */

import { readZip } from './lib/zip.js';
import { extractText, isScannable, extOf } from './lib/textract.js';
import { scanText } from './lib/scan.js';
import { evaluatePacket, MB } from './lib/rules.js';
import { sha256Hex } from './lib/hash.js';
import { buildManifest, diffManifests, describeDiff, receiptText } from './lib/manifest.js';
import { PRESETS, clonePreset } from './lib/presets.js';
import { buildSamplePacket, buildFixFiles, SAMPLE_NAME } from './lib/samples.js';

const $ = (sel) => document.querySelector(sel);

// Text scanning is skipped above this size: a 30MB scanned PDF would stall the
// page, and the useful answer there is the size itself.
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

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

/* ───────────────────────── checklist ───────────────────────── */

function renderPresets() {
  const select = $('#preset-select');
  select.innerHTML = '';
  for (const [key, preset] of Object.entries(PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = preset.name;
    select.append(opt);
  }
  select.value = state.presetKey;
  select.addEventListener('change', () => {
    state.presetKey = select.value;
    state.checklist = clonePreset(select.value);
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
    label.value = item.label;
    label.placeholder = '항목 이름';
    label.addEventListener('input', () => { item.label = label.value; runChecks(); });
    tdLabel.append(label);

    const tdReq = document.createElement('td');
    tdReq.className = 'req';
    const req = document.createElement('input');
    req.type = 'checkbox';
    req.checked = !!item.required;
    req.setAttribute('aria-label', `${item.label} 필수 여부`);
    req.addEventListener('change', () => { item.required = req.checked; runChecks(); });
    tdReq.append(req);

    const tdExt = document.createElement('td');
    const ext = document.createElement('input');
    ext.type = 'text';
    ext.className = 'ext';
    ext.value = (item.extensions || []).join(',');
    ext.placeholder = 'pdf,hwp';
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
    max.setAttribute('aria-label', `${item.label} 최대 용량(MB)`);
    max.addEventListener('input', () => { item.maxMB = Number(max.value) || 0; runChecks(); });
    tdMax.append(max);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = '항목 삭제';
    del.setAttribute('aria-label', `${item.label} 삭제`);
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
  state.checklist.items.push({ label: '새 항목', required: false, extensions: ['pdf'], keywords: [], maxMB: 10 });
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
    p.textContent = '아직 파일이 없습니다. 예시 패킷을 열어 보셔도 됩니다.';
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
    tag.textContent = file.itemLabel ? file.itemLabel : '미분류';
    const del = document.createElement('button');
    del.className = 'icon-btn file-del';
    del.textContent = '×';
    del.title = '이 파일을 패킷에서 빼기';
    del.setAttribute('aria-label', `${file.name} 빼기`);
    del.addEventListener('click', () => removeFile(file.name));
    row.append(name, meta, tag, del);
    wrap.append(row);
  }
}

function removeFile(name) {
  state.files = state.files.filter((f) => f.name !== name);
  state.manifest = null;
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
  setSealHint('파일을 읽는 중…');
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
          added.push({ name, bytes, note: `ZIP을 읽지 못했습니다: ${err.message}` });
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
        note: item.note || '',
      };
      if (record.scannable && record.size > MAX_SCAN_BYTES) {
        record.note = `${(record.size / MB).toFixed(1)}MB — 5MB가 넘어 내용 검사는 건너뛰었습니다.`;
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
  // If the archive already has a single top folder, keep it; otherwise prefix
  // with the archive name so the reader knows where the file came from.
  const first = entryName.split('/')[0];
  const hasCommonRoot = entryName.includes('/');
  return hasCommonRoot || !stem ? entryName : `${stem}/${entryName}`.replace(`${stem}/`, '');
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
  const checklist = state.checklist.items;
  const result = evaluatePacket({
    files: state.files.map((f) => ({ name: f.name, size: f.size, sha: f.sha })),
    checklist,
    limits: { totalMB: state.totalMB },
  });
  for (const file of state.files) file.itemLabel = result.matches[file.name] || '';

  const scanFindings = [];
  for (const file of state.files) {
    for (const hit of file.scan) {
      scanFindings.push({
        severity: hit.severity,
        code: hit.code,
        file: file.name,
        line: hit.line,
        message: `${hit.message}${hit.snippet ? ` — ${hit.snippet}` : ''}`,
      });
    }
    if (file.note) scanFindings.push({ severity: 'note', code: 'UNREAD', file: file.name, message: file.note });
    if (file.scannable && file.partial) {
      scanFindings.push({
        severity: 'note', code: 'PARTIAL', file: file.name,
        message: '텍스트를 일부만 읽었습니다. 이 파일은 직접 한 번 열어 확인하세요.',
      });
    }
    if (file.scannable && !file.text && !file.note) {
      scanFindings.push({
        severity: 'note', code: 'NODOC', file: file.name,
        message: '안에서 글자를 찾지 못했습니다 (스캔 이미지 PDF일 수 있습니다).',
      });
    }
  }

  const blocking = result.findings.filter((f) => f.severity === 'block').length
    + scanFindings.filter((f) => f.severity === 'block').length;
  const warnings = result.findings.filter((f) => f.severity === 'warn').length
    + scanFindings.filter((f) => f.severity === 'warn').length;
  const verdict = blocking ? 'blocked' : warnings ? 'warnings' : state.files.length ? 'ready' : 'empty';

  state.result = {
    ...result,
    findings: [...result.findings, ...scanFindings],
    stats: { ...result.stats, blocking, warnings, files: state.files.length },
    verdict,
  };
  renderVerdict();
  renderFindings();
  renderFiles();
  $('#seal-btn').disabled = !state.files.length;
  setSealHint(state.files.length
    ? (blocking ? '막는 문제가 남아 있습니다. 그래도 봉인하면 그대로 기록됩니다.' : '봉인하면 파일별 SHA-256이 담긴 영수증이 만들어집니다.')
    : '파일을 넣고 검사를 한 번 실행하면 봉인할 수 있습니다.');
}

function renderVerdict() {
  const badge = $('#verdict');
  const v = state.result?.verdict || 'empty';
  const labels = {
    empty: '검사 대기',
    ready: '보내도 됩니다',
    warnings: `주의 ${state.result.stats.warnings}건`,
    blocked: `막힘 ${state.result.stats.blocking}건`,
  };
  badge.dataset.state = v;
  badge.textContent = labels[v];
}

function renderFindings() {
  const wrap = $('#findings');
  wrap.innerHTML = '';
  const findings = (state.result?.findings || []).filter((f) => f.severity !== 'note' || f.code === 'EXTRA');
  const ordered = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  if (!ordered.length && state.files.length) {
    const ok = document.createElement('div');
    ok.className = 'all-clear';
    ok.innerHTML = `<strong>막는 문제가 없습니다.</strong><span>필수 항목이 모두 있고, 형식·용량·중복에서 걸린 것이 없습니다.</span>`;
    wrap.append(ok);
  } else if (!state.files.length) {
    const p = document.createElement('p');
    p.className = 'file-empty';
    p.textContent = '체크리스트를 확인하고 파일을 넣으면 결과가 여기에 나옵니다.';
    wrap.append(p);
  }

  for (const f of ordered) {
    const row = document.createElement('div');
    row.className = `finding ${f.severity}`;
    const sev = document.createElement('div');
    sev.className = 'sev';
    sev.textContent = { block: '막힘', warn: '주의', note: '참고' }[f.severity] || f.severity;
    const body = document.createElement('div');
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = f.message;
    body.append(what);
    if (f.file || f.line) {
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = [f.file, f.line ? `${f.line}행` : ''].filter(Boolean).join(' · ');
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
    packet: $('#packet-name').value || state.checklist.name || 'untitled-packet',
    checklist: state.checklist.items,
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
  head.textContent = 'Sealed receipt';
  box.append(head);

  const pre = document.createElement('pre');
  pre.id = 'receipt-text';
  pre.textContent = receiptText(state.manifest, state.diff);
  box.append(pre);

  const stamp = document.createElement('div');
  stamp.className = 'stamp';
  stamp.textContent = state.manifest.verdict === 'ready' ? 'SEALED · READY' : `SEALED · ${state.manifest.verdict.toUpperCase()}`;
  box.append(stamp);

  if (state.diff) {
    const diff = document.createElement('div');
    diff.className = 'diff';
    const title = document.createElement('strong');
    title.textContent = '이전 봉인과 비교';
    const ul = document.createElement('ul');
    for (const line of describeDiff(state.diff)) {
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
  dl.textContent = 'manifest.json 내려받기';
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
  copy.textContent = '영수증 복사';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#receipt-text').textContent);
    copy.textContent = '복사됨';
    setTimeout(() => { copy.textContent = '영수증 복사'; }, 1500);
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
  $('#packet-name').addEventListener('input', () => { /* used at seal time */ });
  $('#sample-btn').addEventListener('click', async () => {
    state.files = [];
    renderFiles();
    setSealHint('예시 패킷을 만드는 중…');
    const zip = await buildSamplePacket();
    await ingestRaw([{ name: SAMPLE_NAME, bytes: zip }]);
    addDemoFixButton();
    setSealHint('예시 패킷은 일부러 틀린 파일을 담고 있습니다. 빠진 서류를 넣어 보세요.');
  });
  $('#prev-manifest').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      state.prevManifest = JSON.parse(await file.text());
      setSealHint(`이전 봉인(${state.prevManifest.sealedAt.slice(0, 10)})을 불러왔습니다. 봉인하면 차이를 보여 줍니다.`);
    } catch (err) {
      setSealHint('manifest.json을 읽지 못했습니다.');
    }
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
  btn.textContent = '빠진 서류 3장 추가 (예시)';
  btn.addEventListener('click', async () => {
    await ingestRaw(await buildFixFiles());
    btn.remove();
  });
  $('#dropzone').after(btn);
  const actions = document.querySelector('.row-actions.sub');
  if (actions) actions.append(btn);
}

/* ───────────────────────── boot ───────────────────────── */

function boot() {
  renderPresets();
  renderChecklist();
  setupDropzone();
  setupButtons();
  renderFiles();
  runChecks();
  window.__packetproof = { state, runChecks, seal, ingestRaw, removeFile };
}

boot();
