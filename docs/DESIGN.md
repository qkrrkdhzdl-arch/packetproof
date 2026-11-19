# Design notes

## Why a packet, and not a file

A portal validates one file at the moment you upload it. The failures that actually cost people an application happen one level up: the packet. A required document that was never added, a scan that is 4MB over a limit the portal only checks at submit, the same memo twice under two names, a version that looks final and is not.

So the unit Packetproof works on is the folder — the thing you are about to send — and the checks are about the relationships between files, not about any single file.

## Severity is a promise about consequences

| Severity | Meaning | Examples |
| --- | --- | --- |
| **block** | The portal will refuse this, or a reviewer cannot use it | missing required item, wrong extension, over per-file or total size, empty file, card number, token or key |
| **warn** | A person has to decide; the tool cannot | two versions of one document, identical bytes under two names, "최종" repeated, resident registration number present, unfilled placeholders |
| **note** | Informational, no action implied | file matching no item, PDF that could only be read in part, scan skipped for size |

Two decisions worth stating, because they go against the obvious choice:

- **A resident registration number is a warning, not a block.** A government benefit form legitimately needs one. Blocking it would make the tool wrong on exactly the packets that matter most. A card number and an API token are blocking, because no submission form has ever needed them.
- **A missing file is blocking even when it is optional-looking.** If the author marked the item required, the tool honours that; the checklist is the author's statement of what the announcement asked for, not the tool's guess.

## Matching

Files are matched to items by normalised keyword (Unicode NFKC, case folded, spaces and punctuation removed, Korean and English in the same list) and by extension. The best-scoring file wins each item, and an item can only be satisfied once — so two drafts of the same document cannot quietly both count.

When a required item has no match, the finding lists up to three filenames that came closest. That is the difference between "동의서 is missing" and "동의서 is missing, and `동의서_서명_20261118.pdf` is sitting right there" — the second one usually means the keyword list needs one more word.

## Content scanning

Validators rather than pattern soup:

- **Resident registration number**: format `YYMMDD-GXXXXXX`, birth month and day must be real, and the weighted check digit must match. A 13-digit account or order number is not reported.
- **Card number**: 13–19 digits passing Luhn.
- **Secrets**: known prefixes (`ghp_`, `github_pat_`, `sk-`, `AIza`, `AKIA`, `xox[baprs]-`, PEM private key, JWT shape).
- **Placeholders**: numbers whose middle groups are zeros, `[이름]`-style bracket markers, `OOO`, `TODO`/`TBD`, sample names. These are the cheapest real error to catch — a form with `010-0000-0000` still uploads.

Reported values are masked before rendering (`900*******568`): the finding has to be recognisable, not disclosed.

## Text extraction

| Container | How |
| --- | --- |
| `.txt .md .csv .json .html .xml .yml .js .py …` | decode UTF-8, strip BOM, normalise CRLF so line numbers match an editor |
| `.docx .xlsx .pptx .hwpx .odt` | ZIP + XML; read only the parts that hold words, one line per paragraph |
| `.pdf` | inflate every stream, parse `Tj` / `TJ` / `'` / `"` strings, decode escapes, re-decode UTF-8 byte strings |

PDF is best-effort by nature: a CID-font PDF prints glyph ids rather than text, and a scanned PDF has no text at all. The result carries a `partial` flag, and the UI says "I only read part of this" instead of "clean". A tool that reports success it cannot verify is worse than no tool.

## The manifest

```json
{
  "schema": "packetproof/1",
  "packet": "2026 청년 지원사업 신청",
  "sealedAt": "2026-11-19T18:29:26.000Z",
  "verdict": "warnings",
  "counts": { "files": 9, "blocking": 0, "warnings": 8, "totalBytes": 4191 },
  "checklist": [{ "label": "신청서 · 지원서", "required": true, "extensions": ["pdf", "hwp", "hwpx", "docx"] }],
  "files": [{ "name": "지원서_박가온_최종최종최종.pdf", "size": 837, "sha256": "10191ffa…", "item": "신청서 · 지원서" }],
  "openIssues": []
}
```

The diff answers the question people actually ask before a resubmission:

- same name, different hash → **changed** (the silent one: you edited the file and kept the name)
- new hash, new name, old hash gone → **renamed**
- only in the older manifest → **removed**
- only in the newer one → **added**

## No network after load

The app never sends a file anywhere. `tools/smoke.py` records every request the page makes and fails if any of them leaves the origin. This is enforced by the code as much as by the design: there is no `fetch`, no `XHR`, no analytics, no font CDN.

## Known limits

- `DecompressionStream("deflate-raw")` is required (Chrome/Edge 80+, Safari 16.4+, Firefox 113+). There is no fallback inflate implementation, on purpose: writing one badly is how people get zip bombs.
- ZIP64 archives are refused rather than half-read.
- Text scanning is skipped above 5MB per file to keep the page responsive; the size finding still applies.
- The checklist is not inferred from the announcement. That is the next thing worth building, and it is deliberately not faked now.
