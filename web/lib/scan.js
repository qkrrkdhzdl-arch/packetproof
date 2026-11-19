/*
 * scan.js — find things that should not be in a packet.
 *
 * The checks are deliberately deterministic and explainable: an ID number is
 * only flagged when its check digit validates, a card number only when it
 * passes Luhn, and placeholders left in a form ("OOO", "000-0000-0000",
 * "[이름]") are reported as work still to do rather than as leaks. Nothing is
 * guessed and nothing leaves the page.
 */

const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];

/** Korean resident registration number: YYMMDD-GXXXXXX with a valid check digit. */
export function rrnValid(digits) {
  if (!/^\d{13}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const month = d[2] * 10 + d[3];
  const day = d[4] * 10 + d[5];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (d[6] < 1 || d[6] > 8) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * RRN_WEIGHTS[i];
  return (11 - (sum % 11)) % 10 === d[12];
}

/** Luhn check used by payment cards. */
export function luhnValid(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS = [
  [/ghp_[A-Za-z0-9]{30,}/g, 'GitHub personal access token'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'GitHub fine-grained token'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'API secret key (sk-…)'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'Google API key'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS access key id'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key block'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, 'JSON Web Token'],
];

const PLACEHOLDERS = [
  [/0\d{1,2}[-. ]?0{3,4}[-. ]?0{4}/g, 'placeholder phone number'],
  [/0{2,3}-\d{2,4}-\d{4}/g, 'placeholder number'],
  [/(X{6,}|x{6,})-\d{7}/g, 'placeholder ID number'],
  [/\[(이름|성명|주소|연락처|날짜|소속)\]/g, 'unfilled field marker'],
  [/(OOO|○○○|ㅇㅇㅇ)/g, 'unfilled name marker'],
  [/\bTODO\b|\bTBD\b|\bFIXME\b/g, 'unfinished work marker'],
  [/(홍길동|김철수)/g, 'sample name left in the document'],
];

/**
 * @param {string} text
 * @returns {Array<{severity:'block'|'warn'|'note', code:string, line:number, message:string, snippet:string}>}
 */
export function scanText(text) {
  const findings = [];
  if (!text) return findings;
  const lines = text.split('\n');

  const push = (severity, code, index, message, snippet) => {
    findings.push({
      severity,
      code,
      line: lineOf(text, index),
      message,
      snippet: mask(snippet.length > 60 ? snippet.slice(0, 60) + '…' : snippet),
    });
  };

  // 1. Resident registration numbers. A government form needs one, so this is
  // a question for the author rather than a verdict: the tool cannot know
  // whether the number belongs in this particular document.
  for (const m of text.matchAll(/(?<!\d)(\d{6})[-‐ ]?([1-8]\d{6})(?!\d)/g)) {
    const digits = m[1] + m[2];
    if (!rrnValid(digits)) continue;
    push('warn', 'RRN', m.index, '주민등록번호로 보입니다 (검증 숫자 일치) — 이 서류에 꼭 필요한지 확인하세요', digits);
  }

  // 2. Payment card numbers.
  for (const m of text.matchAll(/(?<!\d)(\d[ -]?\d{3}[ -]?\d{4}[ -]?\d{4}(?:[ -]?\d{1,4})?)(?!\d)/g)) {
    const digits = m[1].replace(/[^0-9]/g, '');
    if (digits.length < 13 || !luhnValid(digits)) continue;
    if (findings.some((f) => f.code === 'RRN' && Math.abs(f.line - lineOf(text, m.index)) < 1)) continue;
    push('block', 'CARD', m.index, '카드번호로 보입니다 (Luhn 검증 통과) — 제출 서류에 들어갈 이유가 없습니다', digits);
  }

  // 3. Secrets.
  for (const [re, label] of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      push('block', 'SECRET', m.index, `${label} 형식의 값이 들어 있습니다`, m[0]);
    }
  }

  // 4. Phone numbers: expected on a form, but flagged so the author decides.
  for (const m of text.matchAll(/(?:\+?82[-. ]?)?0?1[016789][-. ]?\d{3,4}[-. ]?\d{4}(?!\d)/g)) {
    push('note', 'PHONE', m.index, '연락처가 들어 있습니다 (본인 것이면 그대로 두세요)', m[0]);
  }

  // 5. Email addresses.
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    push('note', 'EMAIL', m.index, '이메일 주소가 들어 있습니다', m[0]);
  }

  // 6. Placeholders that mean "this form is not finished".
  for (const [re, label] of PLACEHOLDERS) {
    for (const m of text.matchAll(re)) {
      push('warn', 'PLACEHOLDER', m.index, `${label} — 제출 전에 채워야 합니다`, m[0]);
    }
  }

  // De-duplicate identical code+line+snippet (the same number twice on one line).
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.code}:${f.line}:${f.snippet}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.line - b.line);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Keep the shape of a value visible while hiding its value. */
export function mask(value) {
  const v = String(value);
  if (v.length <= 4) return '*'.repeat(v.length);
  const keep = Math.min(3, Math.floor(v.length / 4));
  return v.slice(0, keep) + '*'.repeat(Math.max(1, v.length - keep * 2)) + v.slice(-keep);
}
