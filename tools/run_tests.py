#!/usr/bin/env python3
"""Run docs/tests.html in a real browser and print the results.

    python3 tools/run_tests.py

Serves the app on 127.0.0.1, loads the suite in headless Chromium, and exits
non-zero if any assertion fails. The same page can be opened by hand at
/tests.html.
"""
from __future__ import annotations

import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "docs"
PORT = 8771


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D401 - silence request logs
        pass


def main() -> int:
    handler = lambda *a, **k: Quiet(*a, directory=str(WEB), **k)  # noqa: E731
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright is not installed", file=sys.stderr)
        server.shutdown()
        return 2

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path="/workspace/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome", args=["--no-sandbox"])
            page = browser.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"http://127.0.0.1:{PORT}/tests.html")
            page.wait_for_function("window.__testResults !== undefined", timeout=30000)
            data = page.evaluate("window.__testResults")
            browser.close()
    finally:
        server.shutdown()

    for r in data["results"]:
        mark = "PASS" if r["pass"] else "FAIL"
        print(f"[{mark}] {r['name']}" + (f"  — {r['detail']}" if r["detail"] else ""))
    if errors:
        print("\npage errors:", file=sys.stderr)
        for e in errors:
            print("  " + e, file=sys.stderr)
    print(f"\n{data['total'] - data['failed']}/{data['total']} passed")
    return 0 if data["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
