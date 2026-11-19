#!/usr/bin/env python3
"""Record the Packetproof demo video (under three minutes) against the live site.

    python3 tools/record_demo.py

Each scene is driven by a narrated line: the voice is synthesised first, its
length sets how long the scene holds, then the screen is recorded while the
real app does the real work — the sample packet is the app's own fixture, the
hashes in the receipt are computed live in the page.

Output: tools/out/demo.mp4 (1280x720, H.264 + AAC).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tools" / "out"
AUDIO = ROOT / "tools" / "audio"
BASE = "https://qkrrkdhzdl-arch.github.io/packetproof/"
CHROME = "/workspace/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"
GTTS = "/workspace/.local/bin/gtts-cli"

FFMPEG = None
try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:  # pragma: no cover
    FFMPEG = shutil.which("ffmpeg")

SCENES = [
    {
        "id": "01-title",
        "caption": "",
        "say": (
            "I have sent hundreds of applications in the past year: grants, contests, benefits. "
            "The writing was never the problem. The envelope was."
        ),
    },
    {
        "id": "02-empty",
        "caption": "The checklist is copied from the announcement. The right side is the folder you are about to upload.",
        "say": (
            "This is Packetproof. On the left, the checklist you copy from the announcement. "
            "On the right, the folder you are about to upload."
        ),
    },
    {
        "id": "03-sample",
        "caption": "Sample packet: seven files, the mistakes people actually make.",
        "say": (
            "Here is a sample packet. Seven files, carrying the mistakes people actually make. "
            "It reads the archive in the browser, hashes every file, and looks inside the documents."
        ),
    },
    {
        "id": "04-blocking",
        "caption": "Three blocking issues: two required documents are missing, and the scan is over the size limit.",
        "say": (
            "Three things would stop this submission. Two required documents are missing. "
            "And the certificate scan is over the size the portal allows."
        ),
    },
    {
        "id": "05-inside",
        "caption": "Inside the PDF: a resident registration number whose check digit validates. Inside the Word file: an unfilled placeholder.",
        "say": (
            "It also reads inside the files. The application PDF contains a resident registration number, "
            "and the check digit validates, so it is a real one. The Word document still has an unfilled placeholder, "
            "and two memos are the same bytes under two names."
        ),
    },
    {
        "id": "06-fix",
        "caption": "Add the missing documents, drop the oversized scan. Nothing blocking is left.",
        "say": (
            "Add the two missing documents, and drop the oversized scan. "
            "Nothing blocking is left. Eight warnings remain, because those are judgement calls, and they stay on the record."
        ),
    },
    {
        "id": "07-seal",
        "caption": "Sealing writes a manifest: every file, its size, its SHA-256, and the verdict.",
        "say": (
            "Sealing writes a manifest. Every file, its byte size, its SHA-256, the checklist it satisfied, "
            "and the verdict at the moment you sent it."
        ),
    },
    {
        "id": "08-diff",
        "caption": "Seal again and the two manifests are compared: this file changed and kept its name.",
        "say": (
            "Seal again after replacing a document, and it compares the two receipts. "
            "This file changed and kept its name, which is exactly the change nobody notices."
        ),
    },
    {
        "id": "09-how",
        "caption": "No server, no account, no upload. ZIP from the central directory, Office files as XML, hashing with WebCrypto.",
        "say": (
            "All of it runs in the browser. ZIP is parsed from the central directory and inflated with the platform's own "
            "decompression stream, Office files are unzipped and read as XML, and hashing is WebCrypto. "
            "Nothing is uploaded, and the page makes no requests after it loads."
        ),
    },
    {
        "id": "10-close",
        "caption": "Packetproof — fifty-three tests, and a receipt. github.com/qkrrkdhzdl-arch/packetproof",
        "say": (
            "Packetproof. Fifty-three tests, and a receipt. The link is in the description."
        ),
    },
]

CAPTION_JS = """
(text) => {
  let css = document.getElementById('demo-css');
  if (!css) {
    css = document.createElement('style');
    css.id = 'demo-css';
    css.textContent = `
      .demo-cap{position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;justify-content:center;
        padding:0 24px 26px;pointer-events:none}
      .demo-cap div{background:rgba(24,21,17,.93);color:#f6f2e9;border-left:3px solid #a33223;
        font:500 17px/1.45 Inter,system-ui,-apple-system,sans-serif;padding:12px 18px;border-radius:3px;
        max-width:1000px;box-shadow:0 16px 40px rgba(0,0,0,.35)}
      .demo-title{position:fixed;inset:0;z-index:99998;background:#f4f1ea;display:flex;flex-direction:column;
        justify-content:center;padding:0 96px;gap:14px;transition:opacity .5s}
      .demo-title .eyebrow{font:600 13px/1 ui-monospace,monospace;letter-spacing:.22em;color:#a33223;text-transform:uppercase}
      .demo-title h1{font:600 64px/1.02 "Iowan Old Style",Palatino,Georgia,serif;margin:0;color:#1d1b17;letter-spacing:-.02em}
      .demo-title p{font:400 20px/1.5 Inter,system-ui,sans-serif;color:#4a463d;margin:0;max-width:44ch}
      .demo-title .rule{width:64px;height:3px;background:#a33223;margin:8px 0 2px}
    `;
    document.head.appendChild(css);
    const cap = document.createElement('div');
    cap.className = 'demo-cap';
    cap.innerHTML = '<div></div>';
    document.body.appendChild(cap);
  }
  const bar = document.querySelector('.demo-cap div');
  bar.textContent = text || '';
  bar.style.display = text ? 'block' : 'none';
}
"""

TITLE_JS = """
(show) => {
  let el = document.querySelector('.demo-title');
  if (show) {
    if (!el) {
      el = document.createElement('div');
      el.className = 'demo-title';
      el.innerHTML = `<div class="eyebrow">GenHacks 2026</div>
        <div class="rule"></div>
        <h1>Packetproof</h1>
        <p>Seal what you submit. Check the folder before the portal does, and keep a SHA-256 receipt of exactly what went out.</p>`;
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
    el.style.display = 'flex';
  } else if (el) {
    el.style.opacity = '0';
    setTimeout(() => { el.style.display = 'none'; }, 500);
  }
}
"""


def say(scene: dict) -> Path:
    path = AUDIO / f"{scene['id']}.mp3"
    if not path.exists():
        subprocess.run([GTTS, scene["say"], "--lang", "en", "--output", str(path)], check=True)
    return path


def duration(path: Path) -> float:
    out = subprocess.run([FFMPEG, "-i", str(path)], capture_output=True, text=True).stderr
    for line in out.splitlines():
        if "Duration:" in line:
            hms = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = hms.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    raise RuntimeError(f"no duration for {path}")


def make_changed_pdf(target: Path) -> None:
    """A second version of the ID document, so the diff has something to show."""
    lines = ["주민등록증 사본 (앞면)", "성명: 박가온", "주소: 부산광역시 동래구 차밭골로20번길 62, 703호", "재발급: 2026-11-20"]
    content = ["BT", "/F1 12 Tf", "72 760 Td", "14 TL"]
    for line in lines:
        content.append(f"({line.replace('(', '').replace(')', '')}) Tj")
        content.append("T*")
    content.append("ET")
    stream = "\n".join(content)
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
    ]
    pdf = "%PDF-1.4\n" + "".join(
        f"{i + 1} 0 obj\n{body}\nendobj\n" for i, body in enumerate(objects)
    ) + "trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n"
    target.write_bytes(pdf.encode())


def main() -> int:
    AUDIO.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    if shutil.which("ffmpeg") is None and not FFMPEG:
        print("ffmpeg not found", file=sys.stderr)
        return 2

    timings = {}
    for scene in SCENES:
        timings[scene["id"]] = duration(say(scene))

    from playwright.sync_api import sync_playwright

    video_dir = Path(tempfile.mkdtemp(prefix="packetproof-demo-"))
    changed = Path(tempfile.mkdtemp(prefix="packetproof-files-")) / "신분증_사본.pdf"
    make_changed_pdf(changed)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--force-device-scale-factor=1"])
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            record_video_dir=str(video_dir),
            record_video_size={"width": 1280, "height": 720},
        )
        page = context.new_page()
        page.goto(BASE, wait_until="networkidle")
        page.add_script_tag(content=f"window.__cap = {CAPTION_JS.strip()}; window.__title = {TITLE_JS.strip()};")
        page.evaluate("() => window.__cap('')")
        page.wait_for_timeout(300)

        def hold(scene_id: str, extra: float = 0.35):
            page.wait_for_timeout(int((timings[scene_id] + extra) * 1000))

        # 1 — title card
        page.evaluate("() => window.__title(true)")
        hold("01-title", 0.8)
        page.evaluate("() => window.__title(false)")
        page.wait_for_timeout(650)

        # 2 — the empty app, checklist typed in
        page.evaluate("(t) => window.__cap(t)", SCENES[1]["caption"])
        page.click("#packet-name")
        page.wait_for_timeout(200)
        hold("02-empty")

        # 3 — load the sample packet
        page.evaluate("(t) => window.__cap(t)", SCENES[2]["caption"])
        page.click("#sample-btn")
        page.wait_for_function(
            "() => { const s = window.__packetproof.state; return s.files.length > 0 && s.result && s.result.findings.length > 3; }",
            timeout=120000,
        )
        page.wait_for_timeout(700)
        hold("03-sample")

        # 4 — blocking findings
        page.evaluate("(t) => window.__cap(t)", SCENES[3]["caption"])
        page.evaluate("() => document.querySelector('#result-card').scrollIntoView({behavior:'smooth', block:'start'})")
        page.wait_for_timeout(900)
        hold("04-blocking")

        # 5 — what is inside the documents
        page.evaluate("(t) => window.__cap(t)", SCENES[4]["caption"])
        page.evaluate("""() => {
          const rows = [...document.querySelectorAll('.finding')];
          const target = rows.find(r => r.textContent.includes('주민등록번호')) || rows[3];
          target.scrollIntoView({behavior:'smooth', block:'center'});
          target.style.transition = 'box-shadow .3s';
          target.style.boxShadow = '0 0 0 3px rgba(163,50,35,.35)';
          setTimeout(() => { target.style.boxShadow = 'none'; }, 4000);
        }""")
        page.wait_for_timeout(800)
        hold("05-inside")

        # 6 — fix the packet
        page.evaluate("(t) => window.__cap(t)", SCENES[5]["caption"])
        page.evaluate("() => document.querySelector('#files-card').scrollIntoView({behavior:'smooth', block:'start'})")
        page.wait_for_timeout(700)
        page.click("#fix-btn")
        page.wait_for_timeout(1600)
        page.evaluate("""() => {
          const row = [...document.querySelectorAll('.file-row')].find(r => r.textContent.includes('재학증명서_스캔'));
          row.querySelector('.file-del').click();
        }""")
        page.wait_for_function("document.querySelector('#verdict').dataset.state !== 'blocked'", timeout=30000)
        page.evaluate("() => document.querySelector('#result-card').scrollIntoView({behavior:'smooth', block:'start'})")
        page.wait_for_timeout(900)
        hold("06-fix")

        # 7 — seal
        page.evaluate("(t) => window.__cap(t)", SCENES[6]["caption"])
        page.click("#seal-btn")
        page.wait_for_selector("#receipt-text")
        page.evaluate("() => document.querySelector('#receipt').scrollIntoView({behavior:'smooth', block:'center'})")
        page.wait_for_timeout(900)
        hold("07-seal")

        # 8 — replace a document, seal again, show the diff
        page.evaluate("(t) => window.__cap(t)", SCENES[7]["caption"])
        page.evaluate("""() => {
          const row = [...document.querySelectorAll('.file-row')].find(r => r.textContent.includes('신분증_사본'));
          row.querySelector('.file-del').click();
        }""")
        page.set_input_files("#file-input", str(changed))
        page.wait_for_timeout(1500)
        page.evaluate("() => document.querySelector('#seal-btn').scrollIntoView({behavior:'smooth', block:'center'})")
        page.click("#seal-btn")
        page.wait_for_timeout(900)
        page.evaluate("() => document.querySelector('#receipt .diff').scrollIntoView({behavior:'smooth', block:'center'})")
        page.wait_for_timeout(800)
        hold("08-diff")

        # 9 — how it works, on the page itself
        page.evaluate("(t) => window.__cap(t)", SCENES[8]["caption"])
        page.evaluate("() => window.scrollTo({top:0, behavior:'smooth'})")
        page.wait_for_timeout(900)
        hold("09-how")

        # 10 — close
        page.evaluate("(t) => window.__cap(t)", SCENES[9]["caption"])
        page.evaluate("""() => {
          const pills = document.querySelector('.brand-right');
          pills.style.transition = 'box-shadow .3s';
          pills.style.boxShadow = '0 0 0 3px rgba(31,93,67,.35)';
          setTimeout(() => { pills.style.boxShadow = 'none'; }, 3000);
        }""")
        page.wait_for_timeout(700)
        hold("10-close", 1.2)

        video = page.video.path()
        context.close()
        browser.close()

    # mux: concatenated narration over the recording
    audio_list = [str(AUDIO / f"{s['id']}.mp3") for s in SCENES]
    concat = OUT / "narration.m4a"
    args = [FFMPEG, "-y"]
    for a in audio_list:
        args += ["-i", a]
    filters = "".join(f"[{i}:a]" for i in range(len(audio_list))) + f"concat=n={len(audio_list)}:v=0:a=1[out]"
    pad = "".join(f"[{i}:a]apad=pad_dur=0.35[a{i}];" for i in range(len(audio_list)))
    filters = pad + "".join(f"[a{i}]" for i in range(len(audio_list))) + f"concat=n={len(audio_list)}:v=0:a=1[out]"
    subprocess.run(args + ["-filter_complex", filters, "-map", "[out]", "-c:a", "aac", "-b:a", "160k", str(concat)], check=True, capture_output=True)

    final = OUT / "demo.mp4"
    subprocess.run(
        [FFMPEG, "-y", "-i", str(video), "-i", str(concat),
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(final)],
        check=True, capture_output=True,
    )
    shutil.rmtree(video_dir, ignore_errors=True)
    print("video:", final, "audio total:", round(sum(timings.values()), 1), "s")
    print(json.dumps(timings, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
