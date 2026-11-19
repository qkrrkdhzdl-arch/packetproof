/*
 * rules.js — does this packet actually contain what the announcement asked for?
 *
 * A checklist item is matched to files by keyword (Korean or English) and by
 * extension, so "재학증명서_20261120.pdf" satisfies an item labelled
 * "Proof of enrollment". The engine reports a code and its parameters rather
 * than a finished sentence: the same finding can then be read in English or
 * Korean, and the wording can change without touching the checks.
 */

export const MB = 1024 * 1024;

export function norm(value) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-.,()[\]{}]/g, '');
}

export function extOf(name) {
  const base = name.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function baseOf(name) {
  return name.split('/').pop() || name;
}

/**
 * @param {object} args
 * @param {Array<{name:string,size:number,sha:string}>} args.files
 * @param {Array<{label:string,required:boolean,extensions:string[],keywords:string[],maxMB:number}>} args.checklist
 * @param {{totalMB?:number}} [args.limits]
 */
export function evaluatePacket({ files, checklist, limits = {} }) {
  const findings = [];
  const matches = {};
  const used = new Set();

  const add = (severity, code, file, params = {}) => findings.push({ severity, code, file, params });

  // --- 1. Match files to checklist items -----------------------------------
  const scored = [];
  for (const file of files) {
    const base = norm(baseOf(file.name));
    const ext = extOf(file.name);
    for (const item of checklist) {
      let score = 0;
      const keywords = (item.keywords || []).filter(Boolean).map(norm).filter(Boolean);
      if (keywords.length) {
        for (const kw of keywords) if (base.includes(kw)) score += 10 + kw.length / 100;
      } else if (item.extensions && item.extensions.length) {
        if (item.extensions.includes(ext)) score += 1;
      }
      if (score > 0) scored.push({ file, item, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { file, item } of scored) {
    if (matches[file.name]) continue;
    if (used.has(item.label)) continue;
    matches[file.name] = item.label;
    used.add(item.label);
  }

  // --- 2. Every required item must be present ------------------------------
  for (const item of checklist) {
    if (!item.required) continue;
    if (!used.has(item.label)) {
      add('block', 'MISSING', null, { label: item.label, hint: nearestFiles(item, files) });
    }
  }

  // --- 3. Per-file checks --------------------------------------------------
  for (const file of files) {
    const itemLabel = matches[file.name];
    const item = checklist.find((i) => i.label === itemLabel);
    const ext = extOf(file.name);

    if (file.size === 0) add('block', 'EMPTY', file.name);
    if (item && item.extensions && item.extensions.length && !item.extensions.includes(ext)) {
      add('block', 'FORMAT', file.name, { label: item.label, exts: item.extensions, ext });
    }
    if (item && item.maxMB && file.size > item.maxMB * MB) {
      add('block', 'OVERSIZE', file.name, { mb: +(file.size / MB).toFixed(1), max: item.maxMB, label: item.label });
    }
    if (!itemLabel) add('note', 'EXTRA', file.name);

    // Filename hygiene: the names that make a reviewer open the wrong file.
    const base = baseOf(file.name).replace(/\.[^.]+$/, '');
    const finals = (base.match(/final|최종/gi) || []).length;
    if (finals >= 2) add('warn', 'NAME_VERSION', file.name, { n: finals });
    // '사본' on its own is a legitimate document word (신분증 사본); only the
    // markers left by a duplicate-and-rename gesture are worth flagging.
    if (/\bcopy\b|복사본|복사 \d/i.test(base)) add('warn', 'NAME_COPY', file.name);
    const paren = base.match(/\((\d)\)$/);
    if (paren) add('warn', 'NAME_PAREN', file.name, { n: paren[1] });
    if (/\s{2,}/.test(base) || /^\s|\s$/.test(base)) add('note', 'NAME_SPACE', file.name);
    if (/[A-Za-z가-힣]{40,}/.test(base)) add('note', 'NAME_LONG', file.name);
  }

  // --- 4. Same bytes, two names -------------------------------------------
  const bySha = new Map();
  for (const file of files) {
    if (file.size === 0) continue;
    if (!bySha.has(file.sha)) bySha.set(file.sha, []);
    bySha.get(file.sha).push(file.name);
  }
  for (const [sha, names] of bySha) {
    if (names.length < 2) continue;
    add('warn', 'DUPLICATE', names[0], { n: names.length, names, sha: sha.slice(0, 8) });
  }

  // --- 5. Two versions of the same document -------------------------------
  const byBase = new Map();
  for (const file of files) {
    const key = norm(baseOf(file.name).replace(/\.[^.]+$/, '').replace(/final|최종|\d+|v\d+/gi, ''));
    if (!key) continue;
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(file);
  }
  for (const [, group] of byBase) {
    const shas = new Set(group.map((f) => f.sha));
    if (group.length > 1 && shas.size > 1) {
      add('warn', 'VERSION', group[0].name, { names: group.map((f) => baseOf(f.name)) });
    }
  }

  // --- 6. Whole-packet limits ---------------------------------------------
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (limits.totalMB && totalBytes > limits.totalMB * MB) {
    add('block', 'TOTAL_SIZE', null, { mb: +(totalBytes / MB).toFixed(1), max: limits.totalMB });
  }

  const blocking = findings.filter((f) => f.severity === 'block').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;
  return {
    findings,
    matches,
    stats: {
      files: files.length,
      matched: Object.keys(matches).length,
      totalBytes,
      blocking,
      warnings,
    },
    verdict: blocking ? 'blocked' : warnings ? 'warnings' : 'ready',
  };
}

function nearestFiles(item, files) {
  const words = [...(item.keywords || []), item.label]
    .flatMap((w) => String(w).split(/[\s/]+/))
    .map(norm)
    .filter((w) => w.length >= 2);
  const hits = [];
  for (const file of files) {
    const base = norm(baseOf(file.name));
    if (words.some((w) => base.includes(w) || w.includes(base.replace(/\.[^.]+$/, '')))) hits.push(baseOf(file.name));
  }
  return hits.slice(0, 3);
}
