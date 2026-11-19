/*
 * samples.js — a fixture packet, built in the browser.
 *
 * Judges should not have to go and find six files to see the tool work, so the
 * demo packet is generated here. It carries the mistakes people really make:
 * a consent form that was never added, a 10.3MB scan against a 10MB rule, one
 * memo attached twice under two names, a name with "최종" three times, a form
 * with a resident registration number typed into it, and an unfilled
 * placeholder. Formats match the checklist, so every problem shown is one the
 * packet itself has.
 */

import { makeZip } from './zip.js';

export const SAMPLE_NAME = 'sample-packet-2026-11-18.zip';

export async function buildSamplePacket() {
  const application = makePdf([
    '2026 청년 지원사업 신청서',
    '',
    '성명: 박가온',
    '생년월일: 2003-05-02',
    '주민등록번호: 900101-1234568',
    '휴대전화: 010-7412-0503',
    '',
    '신청 동기: 행정안전부 청년정책자문단에서 1년간 정책 제안을 했고,',
    '그 경험을 지역 지원사업에 옮기려 합니다.',
    '',
    '작성일: 2026-11-18',
  ]);

  const bankCopy = makePdf([
    '통장 사본',
    '은행: 부산은행',
    '계좌번호: 123-456-789012',
    '예금주: 박가온',
    '발급일: 2026-11-17',
  ]);

  const essay = [
    '자기소개서',
    '',
    '담당자: [이름]',
    '연락처: 010-0000-0000',
    '',
    '저는 부산에서 소상공인 70여 곳의 홍보를 맡으며 현장의 언어를 배웠습니다.',
  ].join('\n');

  const notes = [
    '제출 전 메모',
    '',
    '- 통장 사본은 11/17에 새로 받은 것으로 교체',
    '- 재학증명서는 휴학 상태 표기 확인',
    '- 동의서 서명은 아직 안 함 (TODO)',
  ].join('\n');

  // A 10.3MB scan: common, and over the 10MB the checklist allows.
  const heavyScan = makePdf(['재학증명서 (스캔본)', '발급번호 2026-1118-7731', ...Array(215000).fill('스캔 페이지 여백 — 원본 대조용 반복 데이터')]);

  return makeZip([
    { name: '지원서_박가온_최종최종최종.pdf', bytes: application },
    { name: '자기소개서.docx', bytes: await makeDocx('자기소개서', essay) },
    { name: '통장사본_20261117.pdf', bytes: bankCopy },
    { name: '재학증명서_스캔.pdf', bytes: heavyScan },
    { name: '메모_제출전.txt', text: notes },
    { name: '메모_제출전 (1).txt', text: notes },
    { name: '증명사진.png', bytes: fakePng() },
  ]);
}

/** The documents the packet is missing, so the demo can be finished. */
export async function buildFixFiles() {
  return [
    {
      name: '신분증_사본.pdf',
      bytes: makePdf(['주민등록증 사본 (앞면)', '성명: 박가온', '주소: 부산광역시 동래구 차밭골로20번길 62, 703호']),
    },
    {
      name: '개인정보_동의서_서명.pdf',
      bytes: makePdf(['개인정보 수집·이용 동의서', '', '동의함', '서명: 박가온', '2026-11-20']),
    },
    {
      // The same certificate, compressed to fit the 10MB the checklist allows.
      name: '재학증명서_압축.pdf',
      bytes: makePdf(['재학증명서 (압축본)', '발급번호 2026-1118-7731', '부산대학교 총장', '2026-11-18']),
    },
  ];
}

/** A one-page PDF whose text is stored uncompressed, so the demo covers PDFs too. */
export function makePdf(lines) {
  const content = ['BT', '/F1 12 Tf', '72 760 Td', '14 TL'];
  for (const line of lines) {
    content.push(`(${escapePdf(line)}) Tj`, 'T*');
  }
  content.push('ET');
  const stream = content.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  objects.forEach((body, i) => { pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  pdf += 'trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n';
  return new TextEncoder().encode(pdf);
}

function escapePdf(s) {
  return String(s).replace(/[\\()]/g, (c) => '\\' + c);
}

/** Minimal DOCX: enough of a container for the reader to unzip and read. */
export async function makeDocx(title, body) {
  const paragraphs = [title, '', ...body.split('\n')]
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  return makeZip([
    { name: '[Content_Types].xml', text: types },
    { name: 'word/document.xml', text: document },
  ]);
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** 1×1 transparent PNG, to have one genuinely binary file in the packet. */
function fakePng() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
