/*
 * manifest.js — the receipt.
 *
 * A sealed manifest records, for every file, its name, its byte size and its
 * SHA-256, next to the checklist that was used and the verdict at the moment
 * of sealing. Diffing two manifests answers the question people actually ask
 * after a resubmission: what changed since the version I sent yesterday?
 */

export const SCHEMA = 'packetproof/1';

export function buildManifest({ packet, checklist, files, matches, verdict, stats, findings, sealedAt }) {
  return {
    schema: SCHEMA,
    packet: packet || 'untitled-packet',
    sealedAt: sealedAt || new Date().toISOString(),
    verdict,
    counts: {
      files: stats?.files ?? files.length,
      blocking: stats?.blocking ?? 0,
      warnings: stats?.warnings ?? 0,
      totalBytes: stats?.totalBytes ?? files.reduce((n, f) => n + f.size, 0),
    },
    checklist: checklist.map((i) => ({
      label: i.label,
      required: !!i.required,
      extensions: i.extensions || [],
    })),
    files: files.map((f) => ({
      name: f.name,
      size: f.size,
      sha256: f.sha,
      item: matches?.[f.name] || null,
    })),
    openIssues: (findings || [])
      .filter((f) => f.severity === 'block')
      .map((f) => ({ code: f.code, file: f.file, message: f.message })),
  };
}

/** Compare two manifests. Returns what a person would ask about, in order. */
export function diffManifests(prev, next) {
  const before = new Map(prev.files.map((f) => [f.name, f]));
  const after = new Map(next.files.map((f) => [f.name, f]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [name, file] of after) {
    const old = before.get(name);
    if (!old) added.push({ name, sha256: file.sha256 });
    else if (old.sha256 !== file.sha256) changed.push({ name, from: old.sha256, to: file.sha256 });
  }
  for (const [name, file] of before) {
    if (!after.has(name)) removed.push({ name, sha256: file.sha256 });
  }

  // A file that kept its bytes but changed its name is a rename, not a delete+add.
  const renames = [];
  const removedBySha = new Map(removed.map((r) => [r.sha256, r]));
  for (const a of [...added]) {
    const match = removedBySha.get(a.sha256);
    if (!match) continue;
    renames.push({ from: match.name, to: a.name, sha256: a.sha256 });
    removed.splice(removed.indexOf(match), 1);
    added.splice(added.indexOf(a), 1);
    removedBySha.delete(a.sha256);
  }

  const unchanged = next.files.length - added.length - changed.length - renames.length;
  return { added, removed, changed, renames, unchanged, prevSealedAt: prev.sealedAt, nextSealedAt: next.sealedAt };
}

/** Human summary of a diff, for the receipt and for the demo. */
export function describeDiff(d) {
  if (!d) return [];
  const lines = [];
  lines.push(`${d.unchanged}개 파일은 그대로입니다.`);
  for (const c of d.changed) lines.push(`내용이 바뀐 파일: ${c.name} (${c.from.slice(0, 8)} → ${c.to.slice(0, 8)})`);
  for (const a of d.added) lines.push(`새로 들어온 파일: ${a.name}`);
  for (const r of d.removed) lines.push(`빠진 파일: ${r.name}`);
  for (const r of d.renames) lines.push(`이름만 바뀐 파일: ${r.from} → ${r.to}`);
  return lines;
}

export function receiptText(manifest, diff) {
  const date = manifest.sealedAt.replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [
    `PACKETPROOF — sealed packet receipt`,
    `packet: ${manifest.packet}`,
    `sealed: ${date}`,
    `verdict: ${manifest.verdict.toUpperCase()}  (blocking ${manifest.counts.blocking}, warnings ${manifest.counts.warnings})`,
    ``,
    `files (${manifest.files.length}):`,
    ...manifest.files.map((f) => `  ${f.sha256.slice(0, 16)}  ${String(f.size).padStart(9)}  ${f.name}`),
    ``,
    `checks applied: ${manifest.checklist.map((c) => c.label).join(' · ')}`,
  ];
  if (manifest.openIssues.length) {
    lines.push('', 'open blocking issues:');
    lines.push(...manifest.openIssues.map((i) => `  [${i.code}] ${i.file || 'packet'}: ${i.message}`));
  }
  if (diff) {
    lines.push('', 'since the previous seal:', ...describeDiff(diff).map((l) => `  ${l}`));
  }
  return lines.join('\n');
}
