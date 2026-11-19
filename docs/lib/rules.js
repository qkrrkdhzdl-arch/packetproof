/*
 * rules.js — does this packet actually contain what the announcement asked for?
 *
 * A checklist item is matched to files by keyword (Korean or English) and by
 * extension, so "재학증명서_20261120.pdf" satisfies an item labelled
 * "Proof of enrollment". Everything the engine reports comes with the file and
 * the reason, because the point of the tool is that you can argue with it.
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

  const add = (severity, code, file, message) => findings.push({ severity, code, file, message });

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
      const hint = nearestFiles(item, files);
      add('block', 'MISSING', null,
        `필수 항목 「${item.label}」에 해당하는 파일이 없습니다.` +
        (hint.length ? ` 비슷한 파일: ${hint.join(', ')}` : ''));
    }
  }

  // --- 3. Per-file checks --------------------------------------------------
  for (const file of files) {
    const itemLabel = matches[file.name];
    const item = checklist.find((i) => i.label === itemLabel);
    const ext = extOf(file.name);

    if (file.size === 0) {
      add('block', 'EMPTY', file.name, '빈 파일(0바이트)입니다. 업로드해도 내용이 없습니다.');
    }
    if (item && item.extensions && item.extensions.length && !item.extensions.includes(ext)) {
      add('block', 'FORMAT', file.name,
        `「${item.label}」은 ${item.extensions.map((e) => '.' + e).join(' / ')} 형식이어야 하는데 .${ext || '(확장자 없음)'}입니다.`);
    }
    if (item && item.maxMB && file.size > item.maxMB * MB) {
      add('block', 'OVERSIZE', file.name,
        `${(file.size / MB).toFixed(1)}MB — 「${item.label}」의 허용 용량 ${item.maxMB}MB를 넘습니다.`);
    }
    if (!itemLabel) {
      add('note', 'EXTRA', file.name, '체크리스트의 어느 항목에도 해당하지 않는 파일입니다.');
    }

    // Filename hygiene: these are the names that make a reviewer open the wrong file.
    const base = baseOf(file.name).replace(/\.[^.]+$/, '');
    const finals = (base.match(/final|최종/gi) || []).length;
    if (finals >= 2) add('warn', 'NAME_VERSION', file.name, `이름에 '최종'이 ${finals}번 들어갑니다. 어느 것이 최종인지 파일명만으로는 알 수 없습니다.`);
    // '사본' on its own is a legitimate document word (신분증 사본); only the
    // markers left by a duplicate-and-rename gesture are worth flagging.
    if (/\bcopy\b|복사본|복사 \d/i.test(base)) add('warn', 'NAME_COPY', file.name, `'복사본' 표시가 남아 있습니다.`);
    if (/\(\d\)$/.test(base)) add('warn', 'NAME_COPY', file.name, `'(${base.match(/\((\d)\)$/)[1]})'가 붙은 이름입니다. 같은 파일의 다른 판일 가능성이 큽니다.`);
    if (/\s{2,}/.test(base)) add('note', 'NAME_SPACE', file.name, '파일명에 연속 공백이 있습니다.');
    if (/^\s|\s$/.test(base)) add('note', 'NAME_SPACE', file.name, '파일명 앞뒤에 공백이 있습니다.');
    if (/[A-Za-z가-힣]{40,}/.test(base)) add('note', 'NAME_LONG', file.name, '파일명이 40자 이상입니다. 일부 접수 사이트에서 잘립니다.');
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
    add('warn', 'DUPLICATE', names[0],
      `같은 내용의 파일이 ${names.length}개 있습니다: ${names.join(', ')} (${sha.slice(0, 8)})`);
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
      add('warn', 'VERSION', group[0].name,
        `이름이 비슷한 다른 판이 함께 들어 있습니다: ${group.map((f) => baseOf(f.name)).join(', ')} — 심사자는 하나만 읽습니다.`);
    }
  }

  // --- 6. Whole-packet limits ---------------------------------------------
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (limits.totalMB && totalBytes > limits.totalMB * MB) {
    add('block', 'TOTAL_SIZE', null,
      `전체 ${(totalBytes / MB).toFixed(1)}MB — 접수 한도 ${limits.totalMB}MB를 넘습니다.`);
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
