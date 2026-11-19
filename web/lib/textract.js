/*
 * textract.js — get readable text out of the files people actually attach.
 *
 * Plain text is decoded directly. Office and Hangul formats (docx, xlsx,
 * pptx, hwpx, odt) are ZIP containers, so the same zip reader is reused and
 * only the XML parts that hold words are read. PDFs are scanned best-effort:
 * every stream is inflated and the text-showing strings are pulled out, which
 * is enough to find an ID number typed into a form, and the caller is told
 * when the result is partial.
 */

import { readZip, inflateRaw } from './zip.js';

const PLAIN = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'ndjson', 'html', 'htm',
  'xml', 'yml', 'yaml', 'js', 'mjs', 'ts', 'py', 'sh', 'log', 'tex', 'ini', 'toml', 'srt',
]);

/** Which XML parts hold the words, per container format. */
const CONTAINERS = {
  docx: [/^word\/document\d*\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/],
  xlsx: [/^xl\/sharedStrings\.xml$/, /^xl\/worksheets\/sheet\d+\.xml$/],
  pptx: [/^ppt\/slides\/slide\d+\.xml$/, /^ppt\/notesSlides\/notesSlide\d+\.xml$/],
  hwpx: [/^Contents\/section\d*\.xml$/],
  odt: [/^content\.xml$/],
};

const decoder = new TextDecoder('utf-8', { fatal: false });

export function extOf(name) {
  const base = name.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function isScannable(name) {
  const ext = extOf(name);
  return PLAIN.has(ext) || ext === 'pdf' || ext in CONTAINERS;
}

/**
 * @returns {Promise<{text: string, partial: boolean, kind: string}>}
 *   text is '' when nothing readable was found.
 */
export async function extractText(name, bytes) {
  const ext = extOf(name);

  if (PLAIN.has(ext)) {
    // Strip a UTF-8 BOM and normalise line endings so line numbers match what
    // the user sees in an editor.
    const text = decoder.decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    return { text, partial: false, kind: ext };
  }

  if (ext in CONTAINERS) {
    const parts = [];
    let entries;
    try {
      entries = await readZip(bytes);
    } catch (err) {
      return { text: '', partial: true, kind: ext, error: err.message };
    }
    const patterns = CONTAINERS[ext];
    for (const entry of entries) {
      if (entry.dir) continue;
      if (!patterns.some((re) => re.test(entry.name))) continue;
      parts.push(xmlToText(decoder.decode(entry.data)));
    }
    return { text: parts.join('\n'), partial: false, kind: ext };
  }

  if (ext === 'pdf') return extractPdfText(bytes);

  return { text: '', partial: false, kind: ext };
}

/** Turn a word-processing XML part into text with one line per paragraph. */
export function xmlToText(xml) {
  const withBreaks = xml
    .replace(/<\/(w:p|a:p|text:p|row|w:tr|table:table-row)>/g, '\n')
    .replace(/<(w:br|a:br|text:line-break)\s*\/>/g, '\n')
    .replace(/<\/(w:tc|a:tc|table:table-cell)>/g, '\t');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/**
 * Best-effort PDF text. Objects may be compressed, so every stream is tried;
 * whatever text-showing operators we find is joined into lines. This is not a
 * typesetter and the caller is told so via `partial`.
 */
export async function extractPdfText(bytes) {
  const raw = latin1(bytes);
  const pieces = [];
  let sawFlate = false;

  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    const body = m[1];
    const head = raw.slice(Math.max(0, m.index - 400), m.index);
    const bodyBytes = latin1ToBytes(body);
    let decodedRaw = body;
    if (/\/FlateDecode/.test(head)) {
      sawFlate = true;
      try {
        decodedRaw = latin1(await inflateRaw(bodyBytes));
      } catch {
        // Not every stream is a text stream; a failed inflate is expected.
        continue;
      }
    }
    const found = textFromContentStream(decodedRaw);
    if (found) pieces.push(found);
  }

  // Some generators leave the text uncompressed outside any stream; check the
  // whole file as a fallback so we do not report "clean" on an unscanned file.
  if (!pieces.length) {
    const found = textFromContentStream(raw);
    if (found) pieces.push(found);
  }

  const text = pieces.join('\n');
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const partial = sawFlate ? letters < 24 : letters < 8;
  return { text, partial, kind: 'pdf' };
}

/** Pull literal and hex strings that precede Tj / TJ / ' / " operators. */
function textFromContentStream(stream) {
  const out = [];
  const shows = /(\((?:\\.|[^\\()])*\)|\[[^\]]{0,4000}\])\s*(Tj|TJ|'|")\s/g;
  let m;
  while ((m = shows.exec(stream)) !== null) {
    const chunk = m[1];
    const strings = chunk.startsWith('[')
      ? [...chunk.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((x) => x[0])
      : [chunk];
    const line = strings.map(unpdfString).join('');
    if (line.trim()) out.push(line);
  }
  if (!out.length) {
    // Fallback: hex strings used by some CID writers.
    for (const hex of stream.matchAll(/<([0-9A-Fa-f]{8,})>\s*Tj/g)) {
      const v = hex[1];
      let s = '';
      for (let i = 0; i + 3 < v.length; i += 4) s += String.fromCharCode(parseInt(v.slice(i, i + 4), 16));
      if (s.trim()) out.push(s);
    }
  }
  return out.join('\n');
}

function unpdfString(literal) {
  const body = literal.slice(1, -1);
  const escaped = body
    .replace(/\\([nrtbf()\\])/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c))
    .replace(/\\([0-7]{1,3})/g, (m, oct) => String.fromCharCode(parseInt(oct, 8)));
  // PDF strings are bytes. Writers that store UTF-8 (common for Korean
  // documents produced by browser tools) only read correctly when we decode
  // again as UTF-8; when that fails the byte-per-character reading is kept.
  if (!/[\u0080-\u00ff]/.test(escaped)) return escaped;
  const bytes = new Uint8Array(escaped.length);
  for (let i = 0; i < escaped.length; i++) bytes[i] = escaped.charCodeAt(i) & 0xff;
  const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const clean = !asUtf8.includes('\uFFFD') && /[^\x00-\x7f]/.test(asUtf8);
  return clean ? asUtf8 : escaped;
}

function latin1(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return s;
}

function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
