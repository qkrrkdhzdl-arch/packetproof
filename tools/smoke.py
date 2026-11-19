#!/usr/bin/env python3
"""Walk the real page through the demo path and save screenshots.

    python3 tools/smoke.py

Runs the same steps a judge would take: open, load the sample packet, read the
verdict, add the two missing documents, seal, read the receipt. Screenshots
land in docs/shots/ for the README.
"""
from __future__ import annotations

import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "docs"
SHOTS = ROOT / "docs" / "shots"
PORT = 8772
CHROME = "/workspace/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> int:
    SHOTS.mkdir(parents=True, exist_ok=True)
    handler = lambda *a, **k: Quiet(*a, directory=str(WEB), **k)  # noqa: E731
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    from playwright.sync_api import sync_playwright

    requests: list[str] = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
            page.on("request", lambda r: requests.append(r.url))
            page.on("pageerror", lambda e: print("pageerror:", e, file=sys.stderr))

            page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
            page.screenshot(path=str(SHOTS / "01-empty.png"))

            page.fill("#packet-name", "2026 청년 지원사업 신청")
            page.click("#sample-btn")
            page.wait_for_function(
                "() => { const s = window.__packetproof.state; return s.files.length > 0 && s.result && s.result.findings.length > 3; }",
                timeout=60000,
            )
            page.wait_for_timeout(400)
            print("verdict after sample:", page.inner_text("#verdict"))
            print("findings:", [t.strip() for t in page.locator(".finding .what").all_inner_texts()])
            page.screenshot(path=str(SHOTS / "02-blocked.png"), full_page=True)

            page.click("#fix-btn")
            page.wait_for_timeout(1200)
            print("verdict after adding the two documents:", page.inner_text("#verdict"))

            # Drop the oversized scan, the way a person would after the tool tells
            # them the portal will reject it.
            page.evaluate("() => window.__packetproof.removeFile('재학증명서_스캔.pdf')")
            page.wait_for_function("document.querySelector('#verdict').dataset.state !== 'blocked'")
            page.wait_for_timeout(300)
            print("verdict after dropping the oversized scan:", page.inner_text("#verdict"))
            page.screenshot(path=str(SHOTS / "03-ready.png"), full_page=True)

            page.click("#seal-btn")
            page.wait_for_selector("#receipt-text")
            receipt = page.inner_text("#receipt-text")
            print("\n--- receipt ---\n" + receipt[:1200])
            page.screenshot(path=str(SHOTS / "04-receipt.png"), full_page=True)

            manifest = page.evaluate("JSON.stringify(window.__packetproof.state.manifest)")
            print("\nmanifest bytes:", len(manifest))
            browser.close()
    finally:
        server.shutdown()

    offsite = [u for u in requests if "127.0.0.1" not in u]
    print("\nrequests:", len(requests), "offsite:", offsite)
    return 0 if not offsite else 1


if __name__ == "__main__":
    sys.exit(main())
