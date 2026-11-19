/*
 * presets.js — starter checklists.
 *
 * They are guesses, on purpose: the point of the tool is that you edit the
 * list to match the announcement you are reading, and then the same list is
 * checked against what you actually plan to send. Item labels are bilingual
 * and keywords carry both languages, so the same list works either way.
 */

const L = (en, ko) => ({ en, ko });

export const PRESETS = {
  grant: {
    labels: { en: 'Grant · benefit application', ko: '지원사업 · 복지 신청' },
    items: [
      { label: L('Application form', '신청서 · 지원서'), required: true, extensions: ['pdf', 'hwp', 'hwpx', 'docx'], keywords: ['지원서', '신청서', 'application', 'form'], maxMB: 20 },
      { label: L('Copy of ID', '신분증 사본'), required: true, extensions: ['pdf', 'jpg', 'png'], keywords: ['신분증', '주민등록증', 'id', 'identity'], maxMB: 10 },
      { label: L('Copy of bankbook', '통장 사본'), required: true, extensions: ['pdf', 'jpg', 'png'], keywords: ['통장', '계좌', 'bank'], maxMB: 10 },
      { label: L('Proof of enrolment', '재학 · 재직 증명'), required: true, extensions: ['pdf'], keywords: ['재학', '휴학', '재직', '증명', 'proof', 'enroll'], maxMB: 10 },
      { label: L('Privacy consent', '개인정보 동의서'), required: true, extensions: ['pdf', 'jpg', 'png'], keywords: ['동의', '서명', 'consent', 'signature'], maxMB: 10 },
    ],
    totalMB: 50,
  },
  hackathon: {
    labels: { en: 'Hackathon · contest entry', ko: '해커톤 · 공모전 제출' },
    items: [
      { label: L('Written description', '작품 설명서'), required: true, extensions: ['pdf', 'md', 'docx'], keywords: ['설명', '제안', 'description', 'submission', 'entry'], maxMB: 20 },
      { label: L('Slide deck', '발표 자료'), required: true, extensions: ['pdf', 'pptx'], keywords: ['발표', '피피티', 'deck', 'slide', 'pitch'], maxMB: 30 },
      { label: L('Pledge · consent', '서약 · 동의서'), required: true, extensions: ['pdf'], keywords: ['서약', '동의', 'pledge', 'consent'], maxMB: 10 },
      { label: L('Demo link notes', '시연 영상 링크 정리'), required: false, extensions: ['txt', 'md'], keywords: ['영상', '링크', 'video', 'link'], maxMB: 5 },
    ],
    totalMB: 60,
  },
  job: {
    labels: { en: 'Job application', ko: '채용 지원' },
    items: [
      { label: L('Resume', '이력서'), required: true, extensions: ['pdf'], keywords: ['이력서', 'resume', 'cv'], maxMB: 10 },
      { label: L('Cover letter', '자기소개서'), required: true, extensions: ['pdf', 'docx'], keywords: ['자기소개', 'cover', 'letter'], maxMB: 10 },
      { label: L('Portfolio', '포트폴리오'), required: false, extensions: ['pdf'], keywords: ['포트폴리오', 'portfolio'], maxMB: 30 },
      { label: L('Transcript · career proof', '성적 · 경력 증명'), required: false, extensions: ['pdf'], keywords: ['성적', '경력', 'transcript', 'career'], maxMB: 10 },
    ],
    totalMB: 40,
  },
  custom: { labels: { en: 'Custom checklist', ko: '직접 입력' }, items: [] },
};

export function clonePreset(key) {
  const preset = PRESETS[key] || PRESETS.custom;
  return {
    key,
    totalMB: preset.totalMB || 50,
    items: preset.items.map((i) => ({
      ...i,
      label: { ...i.label },
      extensions: [...i.extensions],
      keywords: [...i.keywords],
    })),
  };
}
