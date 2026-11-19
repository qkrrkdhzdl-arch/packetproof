# Packetproof

**Seal what you submit.** Drop the folder you are about to upload. Packetproof tells you what the portal will reject — before you send it — and leaves a SHA-256 receipt of exactly what went out. English and Korean, in the same page.

Live: **https://qkrrkdhzdl-arch.github.io/packetproof/** · Tests: **/tests.html** · GenHacks 2026 · Track: *AI, Agentic Systems, Cybersecurity & Dev Tools*

![The packet after loading the sample: three blocking issues, five warnings, and a receipt waiting](docs/shots/02-blocked.png)

---

## The problem

Every application ends the same way: you gather five documents into a folder, upload them one by one to a portal that closes at some hour in some timezone, and then you find out — days later, by email, if you are lucky — that the consent form was never attached, that the scan was 14MB against a 10MB limit, that the same memo went in twice under two names, or that the file the reviewer opened was `지원서_최종_최종_진짜최종.pdf`.

Portals validate one file at a time, at the moment of upload, and they forget everything when you close the tab. Nobody checks the packet as a packet.

I have sent several hundred applications in the last year: grants, contests, hackathons, benefits. The failures were never in the writing. They were in the envelope.

## What it does

**A checklist you copy from the announcement.** Each item has a name, whether it is required, the formats allowed, and a size cap. Items are matched to files by keyword in Korean or English — `재학증명서_20261120.pdf` satisfies *Proof of enrollment* — so you do not have to rename anything to be understood.

**A verdict, in three levels.** *Blocking* means the portal will refuse it or a reviewer cannot read it: a required item is missing, a format is wrong, a file is over the cap, the total is over the cap, a file is empty. *Warning* means a human should decide: two versions of the same document, the same bytes under two names, "최종" three times in one filename, an ID number in a document, an unfilled `[이름]`. *Note* is informational: a file that matches no item, a PDF whose text could only be read in part.

**Content checks inside the documents.** Not just names and sizes. Plain text, `.docx`, `.xlsx`, `.pptx`, `.hwpx` and `.odt` are read by unzipping them and reading the XML that holds the words; PDFs are scanned best-effort by inflating their streams and pulling out the text-showing strings. What it looks for:

| Check | Why it is there |
| --- | --- |
| Resident registration number, **check digit validated** | An ID number in the wrong document is the difference between an application and a data leak |
| Payment card, **Luhn validated** | There is no reason for a card number to be in a submission packet |
| Tokens and keys (`ghp_`, `sk-`, `AIza`, `AKIA`, `-----BEGIN PRIVATE KEY-----`, JWT) | People paste config files into submissions |
| Placeholders (`010-0000-0000`, `[이름]`, `OOO`, `TODO`, `홍길동`) | A form that was never finished still uploads fine |
| Phone, email | Expected on a form — reported so the author decides, not to alarm |

**A receipt you can keep.** Sealing builds a manifest: every file, its byte size, its SHA-256, the item it satisfied, the checklist that was used, the verdict, the blocking issues left open, and a UTC timestamp. Download it as JSON, copy it as text, or keep it in the browser. Seal again tomorrow and Packetproof diffs the two: *which file changed while keeping its name*, *what was added*, *what is missing* — the question you actually ask before a resubmission.

![The sealed receipt](docs/shots/04-receipt.png)

## Two languages, one engine

The interface, the findings and the receipt read in English or Korean (the toggle is in the header; the default follows the browser). The checks never produce a finished sentence — a finding is a code plus parameters, and `docs/lib/i18n.js` turns it into words — so adding a language is adding a dictionary, not touching the engine. That matters here: the person preparing a Korean grant packet and the reviewer reading an English report are looking at the same verdict.

## Privacy by construction

There is no server, no account and no upload. Files are read with `FileReader`, hashed with `crypto.subtle`, unzipped with the platform's `DecompressionStream`, and compared in memory. The page makes **zero requests after load** — the smoke test asserts this, and you can watch it in the Network tab while the sample packet runs.

That is a design decision, not a limitation: the most sensitive file you own is the one you are about to attach to a form.

## How it is built

Vanilla ES modules, no build step, no dependencies. The interesting parts:

- **`docs/lib/zip.js`** — a ZIP reader that walks the *central directory* rather than the local headers, so archives from macOS, Windows Explorer, 7-Zip and JSZip all parse the same way, including entries written with data descriptors. Stored entries are sliced; deflated entries go through `DecompressionStream("deflate-raw")`, which means no third-party inflate code ships and the browser's own (fast, native) decompressor does the work. A small writer is included so the test fixtures and the sample packet can be built in memory.
- **`docs/lib/textract.js`** — text from the formats people really attach. Office and Hangul formats are ZIP+XML, so the same reader is reused and only the parts that hold words are read (`word/document.xml`, `xl/sharedStrings.xml`, `ppt/slides/*.xml`, `Contents/section*.xml`). PDFs are the hard case: every stream is inflated, text-showing operators (`Tj`, `TJ`, `'`, `"`) are parsed, escapes are decoded, and UTF-8 byte strings are re-decoded — with a `partial` flag so the UI can say "I only read part of this".
- **`docs/lib/scan.js`** — validators, not vibes. A 13-digit number is only reported as a resident registration number when the weighted check digit matches *and* the birth date is real; a card number only when it passes Luhn. Placeholders are matched by shape. Values are masked before they are ever rendered.
- **`docs/lib/rules.js`** — the packet engine: keyword/ext matching, per-item and whole-packet limits, duplicate bytes by hash, competing versions of one document, filename hygiene. Every finding names the file and the reason, because the point is that you can argue with it.
- **`docs/lib/manifest.js`** — the schema (`packetproof/1`) and the diff, including rename detection (same bytes, new name is a rename, not a delete plus an add).

```
docs/          (published by GitHub Pages)
  index.html   the page
  app.js       state, rendering, drop handling
  lib/zip.js       read/write ZIP
  lib/textract.js  text out of txt/docx/xlsx/pptx/hwpx/odt/pdf
  lib/scan.js      RRN · Luhn · secrets · placeholders
  lib/rules.js     checklist matching and packet checks
  lib/manifest.js  seal and diff
  lib/samples.js   the in-browser sample packet
  lib/i18n.js      every string, in English and Korean
  tests.html / tests.js   60 assertions
tools/
  run_tests.py   runs the suite in headless Chromium
  smoke.py       walks the demo path and writes docs/shots/
```

## Run it

```bash
# any static server works; there is no build step
python3 -m http.server 8080 --directory docs
# then open http://localhost:8080/
```

Press **예시 패킷 열기** to load the sample: seven files that carry six real mistakes. Add the three missing documents, drop the 14MB scan, and seal.

Tests:

```bash
python3 tools/run_tests.py     # 60/60 assertions in a real browser
python3 tools/smoke.py         # UI path + screenshots + "no offsite requests" check
```

## What it does not do

- **It does not read scanned images.** A PDF that is one big JPEG yields no text; the UI says so instead of claiming the packet is clean.
- **It skips text scanning above 5MB.** The size itself is the finding there.
- **It does not edit your files.** It tells you what to fix; you fix it and drop the folder again.
- **The interface is bilingual, the checklist is not translated for you.** Items you type are kept as you typed them.
- **It cannot know your announcement.** The checklist is a starting point — the tool is only as good as the list you give it, which is why the list is editable inline.
- **Korean RRN check digits follow the resident-number formula.** Foreigner registration numbers use a different rule and may show up as an unvalidated 13-digit number, not a finding.

## License

MIT — see [LICENSE](LICENSE).

Built for **GenHacks 2026** (submissions close 2026-12-26). Sample documents in `docs/lib/samples.js` are generated fixtures; the names and numbers in them are not real people.

**Tools used:** written in plain JavaScript; no framework, no library beyond the browser platform. An AI coding assistant was used while writing and reviewing the code — every finding above was verified by running the test suite and the page, and the numbers in this README come from those runs.
