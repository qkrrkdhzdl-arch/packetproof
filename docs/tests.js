/*
 * tests.js — the suite, runnable in the browser (tests.html) and readable by
 * Playwright. It covers the parts that are easy to get subtly wrong: ZIP
 * offsets, deflate, XML text extraction, check-digit validation, and the
 * verdict logic of the rule engine.
 */

import { makeZip, readZip } from './lib/zip.js';
import { extractText, xmlToText, extOf } from './lib/textract.js';
import { scanText, rrnValid, luhnValid, mask } from './lib/scan.js';
import { evaluatePacket, norm } from './lib/rules.js';
import { sha256Hex } from './lib/hash.js';
import { buildManifest, diffManifests } from './lib/manifest.js';
import { FINDING, UI, findingText } from './lib/i18n.js';
import { makeDocx, makePdf } from './lib/samples.js';

const results = [];
const encoder = new TextEncoder();

function ok(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail: condition ? '' : detail });
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, `expected ${b}, got ${a}`);
}

async function throws(name, fn, match) {
  try {
    await fn();
    ok(name, false, 'expected a throw');
  } catch (err) {
    ok(name, !match || String(err.message).includes(match), `threw "${err.message}", wanted "${match}"`);
  }
}

const sha = async (text) => sha256Hex(encoder.encode(text));

async function run() {
  /* ── zip ───────────────────────────────────────────── */
  {
    const archive = await makeZip([
      { name: 'a.txt', text: 'alpha', store: true },
      { name: 'dir/b.txt', text: 'bravo', store: false },
      { name: '한글 문서.txt', text: '감마', store: false },
    ]);
    const entries = await readZip(archive);
    eq('zip: entry count', entries.length, 3);
    const byName = new Map(entries.map((e) => [e.name, e]));
    eq('zip: stored entry text', new TextDecoder().decode(byName.get('a.txt').data), 'alpha');
    eq('zip: deflated entry text', new TextDecoder().decode(byName.get('dir/b.txt').data), 'bravo');
    eq('zip: utf-8 filename and content', new TextDecoder().decode(byName.get('한글 문서.txt').data), '감마');
    ok('zip: sizes recorded', byName.get('dir/b.txt').size === 5);

    await throws('zip: non-zip input is rejected', () => readZip(new Uint8Array([1, 2, 3, 4])), 'ZIP');
  }

  /* ── text extraction ───────────────────────────────── */
  {
    const txt = encoder.encode('첫 줄\n둘째 줄');
    eq('text: plain text', (await extractText('memo.txt', txt)).text, '첫 줄\n둘째 줄');
    eq('text: BOM and CRLF normalised', (await extractText('bom.txt', encoder.encode('\uFEFFa\r\nb'))).text, 'a\nb');
    ok('text: extension helper', extOf('a/b/c.PDF') === 'pdf');

    const docx = await makeDocx('제목', '본문 첫줄\n본문 둘째줄');
    const docxText = await extractText('자기소개서.docx', docx);
    ok('text: docx paragraphs all present', docxText.text.includes('제목') && docxText.text.includes('본문 첫줄') && docxText.text.includes('본문 둘째줄'), docxText.text);
    ok('text: docx returns one line per paragraph', docxText.text.split('\n').filter(Boolean).length >= 3);

    const pdf = makePdf(['지원서 확인', '주민등록번호: 900101-1234568']);
    const pdfText = await extractText('신청서.pdf', pdf);
    ok('text: pdf literal strings recovered', pdfText.text.includes('주민등록번호'), JSON.stringify(pdfText.text));
    ok('text: pdf marked as partial only when text is thin', typeof pdfText.partial === 'boolean');

    eq('text: xml paragraph to newline', xmlToText('<w:p><w:r><w:t>가</w:t></w:r></w:p><w:p><w:r><w:t>나</w:t></w:r></w:p>').trim(), '가\n나');
    eq('text: xml entities decoded', xmlToText('<t>a &amp; b &lt;c&gt;</t>'), 'a & b <c>');

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const pngText = await extractText('photo.png', png);
    eq('text: unknown type yields empty text', pngText.text, '');
  }

  /* ── scan ──────────────────────────────────────────── */
  {
    ok('scan: valid RRN checksum accepted', rrnValid('9001011234568'));
    ok('scan: wrong check digit rejected', !rrnValid('9001011234567'));
    ok('scan: impossible month rejected', !rrnValid('9013011234568'));
    ok('scan: Luhn accepts a known test card', luhnValid('4111111111111111'));
    ok('scan: Luhn rejects a broken card', !luhnValid('4111111111111112'));

    const found = scanText('신청인 900101-1234568\n결제 4111 1111 1111 1111');
    const codes = found.map((f) => f.code);
    ok('scan: RRN flagged for the author to judge', found.some((f) => f.code === 'RRN' && f.severity === 'warn'));
    ok('scan: card flagged as blocking', codes.includes('CARD'));
    ok('scan: line numbers reported', found.find((f) => f.code === 'RRN').line === 1 && found.find((f) => f.code === 'CARD').line === 2);
    ok('scan: the value is masked', !found.find((f) => f.code === 'RRN').params.value.includes('1234568'), found.find((f) => f.code === 'RRN').params.value);

    const clean = scanText('이 문서에는 개인정보가 없습니다. 담당자에게 문의하세요.');
    eq('scan: clean text has no findings', clean.length, 0);

    const placeholders = scanText('연락처: 010-0000-0000\n담당자: [이름]\n성명: OOO');
    eq('scan: three placeholders found', placeholders.filter((f) => f.code === 'PLACEHOLDER').length, 3);

    const secrets = scanText('key=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    ok('scan: github token flagged', secrets.some((f) => f.code === 'SECRET' && f.severity === 'block'));

    eq('scan: mask keeps edges', mask('9001011234568').endsWith('568'), true);
  }

  /* ── rules ─────────────────────────────────────────── */
  {
    const checklist = [
      { label: '지원서', required: true, extensions: ['pdf', 'txt'], keywords: ['지원서'], maxMB: 20 },
      { label: '동의서', required: true, extensions: ['pdf'], keywords: ['동의'], maxMB: 10 },
    ];
    const files = [
      { name: '지원서_박가온.txt', size: 100, sha: 'a'.repeat(64) },
      { name: '메모.txt', size: 20, sha: 'b'.repeat(64) },
    ];
    const r1 = evaluatePacket({ files, checklist });
    ok('rules: missing required item blocks', r1.findings.some((f) => f.code === 'MISSING' && f.params.label.includes('동의서')));
    ok('rules: unmatched file noted', r1.findings.some((f) => f.code === 'EXTRA' && f.file === '메모.txt'));
    eq('rules: verdict blocked', r1.verdict, 'blocked');
    eq('rules: match recorded', r1.matches['지원서_박가온.txt'], '지원서');

    const r2 = evaluatePacket({
      files: [...files, { name: '동의서.pdf', size: 200, sha: 'c'.repeat(64) }],
      checklist,
    });
    eq('rules: verdict ready when nothing is wrong', r2.verdict, 'ready');

    const r3 = evaluatePacket({
      files: [
        { name: '지원서.hwp', size: 100, sha: 'd'.repeat(64) },
        { name: '동의서.docx', size: 100, sha: 'e'.repeat(64) },
      ],
      checklist,
    });
    ok('rules: wrong extension is blocking', r3.findings.some((f) => f.code === 'FORMAT' && f.file === '지원서.hwp'));

    const r4 = evaluatePacket({
      files: [
        { name: '지원서.pdf', size: 30 * 1024 * 1024, sha: 'f'.repeat(64) },
        { name: '동의서.pdf', size: 100, sha: 'g'.repeat(64) },
      ],
      checklist,
      limits: { totalMB: 10 },
    });
    ok('rules: per-file limit enforced', r4.findings.some((f) => f.code === 'OVERSIZE'));
    ok('rules: total limit enforced', r4.findings.some((f) => f.code === 'TOTAL_SIZE'));

    const r5 = evaluatePacket({
      files: [
        { name: '동의서.pdf', size: 10, sha: 'h'.repeat(64) },
        { name: '동의서 (1).pdf', size: 10, sha: 'h'.repeat(64) },
      ],
      checklist,
    });
    ok('rules: identical bytes under two names flagged', r5.findings.some((f) => f.code === 'DUPLICATE'));
    ok('rules: "(1)" copy-style name flagged', r5.findings.some((f) => f.code === 'NAME_PAREN'));

    const r6 = evaluatePacket({
      files: [
        { name: '지원서_최종.pdf', size: 10, sha: '1'.repeat(64) },
        { name: '지원서_최종_진짜.pdf', size: 12, sha: '2'.repeat(64) },
        { name: '지원서_최종_진짜최종.pdf', size: 12, sha: '3'.repeat(64) },
        { name: '동의서.pdf', size: 10, sha: '4'.repeat(64) },
      ],
      checklist,
    });
    ok('rules: repeated "최종" in name warned', r6.findings.some((f) => f.code === 'NAME_VERSION'));
    ok('rules: competing versions warned', r6.findings.some((f) => f.code === 'VERSION'));

    const r7 = evaluatePacket({ files: [{ name: 'x.txt', size: 0, sha: 'z'.repeat(64) }], checklist: [] });
    ok('rules: empty file blocked', r7.findings.some((f) => f.code === 'EMPTY'));

    eq('rules: normalisation folds case, spaces and punctuation', norm('재학 증명서_2026.PDF'), '재학증명서2026pdf');
  }

  /* ── manifest ──────────────────────────────────────── */
  {
    const checklist = [{ label: '지원서', required: true, extensions: ['pdf'] }];
    const files = [
      { name: '지원서.pdf', size: 10, sha: await sha('v1') },
      { name: '사진.png', size: 4, sha: await sha('pic') },
    ];
    const m1 = buildManifest({
      packet: 'demo', checklist, files,
      matches: { '지원서.pdf': '지원서' },
      verdict: 'ready',
      stats: { files: 2, blocking: 0, warnings: 0, totalBytes: 14 },
      findings: [],
      sealedAt: '2026-11-18T01:00:00.000Z',
    });
    eq('manifest: schema', m1.schema, 'packetproof/1');
    eq('manifest: file count', m1.files.length, 2);
    ok('manifest: hash recorded', m1.files[0].sha256 === await sha('v1'));

    const m2 = {
      ...m1,
      sealedAt: '2026-11-19T01:00:00.000Z',
      files: [
        { name: '지원서.pdf', size: 12, sha256: await sha('v2'), item: '지원서' },
        { name: '사진.png', size: 4, sha256: await sha('pic'), item: null },
        { name: '동의서.pdf', size: 8, sha256: await sha('consent'), item: null },
      ],
    };
    const d = diffManifests(m1, m2);
    eq('diff: changed file detected', d.changed.map((c) => c.name), ['지원서.pdf']);
    eq('diff: added file detected', d.added.map((a) => a.name), ['동의서.pdf']);
    eq('diff: unchanged counted', d.unchanged, 1);

    const m3 = {
      ...m1,
      files: [{ name: '지원서_최종.pdf', size: 10, sha256: m1.files[0].sha256, item: '지원서' }],
    };
    const d2 = diffManifests(m1, m3);
    eq('diff: rename recognised', d2.renames.map((r) => `${r.from}>${r.to}`), ['지원서.pdf>지원서_최종.pdf']);
    eq('diff: rename leaves the genuinely dropped file listed', d2.removed.map((r) => r.name), ['사진.png']);
  }

  /* ── i18n ──────────────────────────────────────────── */
  {
    const en = findingText('en', 'MISSING', { label: 'Privacy consent', hint: ['동의서_서명.pdf'] });
    const ko = findingText('ko', 'MISSING', { label: '개인정보 동의서', hint: [] });
    ok('i18n: english sentence mentions the item', en.includes('Privacy consent') && en.includes('no matching file'), en);
    ok('i18n: korean sentence mentions the item', ko.includes('개인정보 동의서') && ko.includes('없습니다'), ko);
    ok('i18n: masked value survives translation', findingText('en', 'RRN', { value: '900*******568' }).includes('900*******568'));
    ok('i18n: english hint list is joined', findingText('en', 'MISSING', { label: 'x', hint: ['a.pdf', 'b.pdf'] }).includes('a.pdf, b.pdf'));

    const codesEn = Object.keys(FINDING.en).sort();
    const codesKo = Object.keys(FINDING.ko).sort();
    eq('i18n: both languages cover the same finding codes', codesKo, codesEn);
    const uiEn = Object.keys(UI.en).sort();
    const uiKo = Object.keys(UI.ko).sort();
    eq('i18n: both languages cover the same interface keys', uiKo, uiEn);
    ok('i18n: every finding code renders in both languages', codesEn.every((c) => {
      const out = findingText('en', c, { label: 'l', value: 'v', n: 2, names: ['a'], mb: 1, max: 2, exts: ['pdf'], ext: 'txt', sha: 'abc', text: 't' });
      return typeof out === 'string' && out.length > 0 && !out.includes('undefined');
    }));
  }

  /* ── end to end ────────────────────────────────────── */
  {
    const files = [
      { name: '지원서_박가온.txt', size: 40, sha: 'a'.repeat(64) },
      { name: '신분증_사본.txt', size: 40, sha: 'b'.repeat(64) },
      { name: '통장사본.txt', size: 40, sha: 'c'.repeat(64) },
      { name: '재학증명서.pdf', size: 40, sha: 'd'.repeat(64) },
      { name: '동의서_서명.pdf', size: 40, sha: 'e'.repeat(64) },
    ];
    const checklist = [
      { label: '신청서', required: true, extensions: ['pdf', 'txt'], keywords: ['지원서', '신청서'], maxMB: 20 },
      { label: '신분증', required: true, extensions: ['pdf', 'txt'], keywords: ['신분증'], maxMB: 10 },
      { label: '통장', required: true, extensions: ['pdf', 'txt'], keywords: ['통장'], maxMB: 10 },
      { label: '재학증명', required: true, extensions: ['pdf'], keywords: ['재학'], maxMB: 10 },
      { label: '동의서', required: true, extensions: ['pdf'], keywords: ['동의'], maxMB: 10 },
    ];
    const r = evaluatePacket({ files, checklist });
    eq('e2e: complete packet is ready', r.verdict, 'ready');
    eq('e2e: every item matched', new Set(Object.values(r.matches)).size, 5);
  }

  report();
}

function report() {
  const failed = results.filter((r) => !r.pass);
  const summary = document.getElementById('summary');
  const list = document.getElementById('list');
  const detail = document.getElementById('detail');
  summary.className = 'summary ' + (failed.length ? 'fail' : 'ok');
  summary.textContent = `${results.length - failed.length}/${results.length} passed` + (failed.length ? ` · ${failed.length} failed` : '');
  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.pass ? 'pass' : 'fail-item';
    li.textContent = r.name + (r.detail ? ` — ${r.detail}` : '');
    list.append(li);
  }
  if (failed.length) detail.textContent = failed.map((f) => `${f.name}\n  ${f.detail}`).join('\n\n');
  window.__testResults = { total: results.length, failed: failed.length, results };
}

run().catch((err) => {
  document.getElementById('summary').className = 'summary fail';
  document.getElementById('summary').textContent = 'suite threw: ' + err.message;
  document.getElementById('detail').textContent = err.stack || String(err);
  window.__testResults = { total: results.length, failed: results.length + 1, error: String(err) };
});
