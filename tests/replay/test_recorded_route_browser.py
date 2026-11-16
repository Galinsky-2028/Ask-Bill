"""AB-076: record a fixed route in real Chromium, download the redacted trace, replay it with the CLI.

The trace must reproduce every pointing decision (exit 0), must be rejected for another layout
(exit 3), and must not contain the page's source text or anything typed into the question box.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SECRET = "my private landlord question 4815"


def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(["node", "apps/web/application/start.mjs", "--demo"], cwd=ROOT,
                            env={**os.environ, "PORT": str(port), "ASK_BILL_STAGE": "development", "ASK_BILL_CHARACTER_STAGE": "true",
                                 "ASK_BILL_CHARACTER_BACKEND": "webgl2", "ASK_BILL_CHARACTER_RECORDER": "true"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/health/live", timeout=0.3)
                break
            except Exception:
                if proc.poll() is not None:
                    raise RuntimeError(proc.stderr.read())
                time.sleep(0.1)
        binary = "/usr/bin/chromium" if Path("/usr/bin/chromium").exists() else os.environ.get("ASK_BILL_CHROME")
        options = {"executable_path": binary} if binary else {"channel": "chromium"}
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"], **options)
            page = browser.new_page(viewport={"width": 1280, "height": 800}, accept_downloads=True)
            page.goto(base + "/bills")
            version = [h for h in page.eval_on_selector_all("a[href]", "e => e.map(x => x.getAttribute('href'))") if "/versions/" in h][0]
            page.goto(base + version)
            for _ in range(240):
                if page.evaluate("() => document.querySelector('.bill-stage')?.dataset.state") == "3d:ready":
                    break
                page.wait_for_timeout(250)
            question = page.locator("#question")
            if question.count():
                question.evaluate("(el, v) => { el.disabled = false; el.value = v; }", SECRET)
            page.evaluate("() => document.querySelector('#bill-document [data-provision-id]').scrollIntoView({block: 'start'})")
            page.wait_for_timeout(300)
            page.evaluate("""() => {
              const reader = document.querySelector('[data-reader]');
              const ids = [...document.querySelectorAll('#bill-document [data-provision-id]')].map(s => s.dataset.provisionId);
              const fire = (name, detail) => document.dispatchEvent(new CustomEvent(name, {detail}));
              fire('askbill:answer-state', {phase: 'answering'});
              for (const id of ids) fire('askbill:source-focus', {versionId: reader.dataset.versionId, provisionId: id});
              fire('askbill:answer-state', {phase: 'supported'});
            }""")
            page.wait_for_timeout(300)
            with page.expect_download() as info:
                page.get_by_role("button", name="Download performance trace (no conversation text)").click()
            with tempfile.TemporaryDirectory() as tmp:
                trace = Path(tmp) / "trace.json"
                info.value.save_as(trace)
                text = trace.read_text()
                recording = json.loads(text)
                source_text = page.evaluate("() => document.querySelector('#bill-document pre.statutory-text').textContent.trim().slice(0, 40)")
                assert SECRET not in text and source_text not in text, "trace must not contain conversation or source text"
                focus = [e for e in recording["events"] if e["type"] == "focus"]
                assert len(focus) >= 2 and any(e["result"]["action"] == "point" for e in focus), focus
                ok = subprocess.run(["node", "tools/performance/inspect.mjs", str(trace), "--version", recording["versionId"],
                                     "--layout", recording["layoutHash"]], cwd=ROOT, capture_output=True, text=True)
                assert ok.returncode == 0 and "divergences: 0" in ok.stdout, ok.stdout + ok.stderr
                bad = subprocess.run(["node", "tools/performance/inspect.mjs", str(trace), "--version", recording["versionId"],
                                      "--layout", "0" * 64], cwd=ROOT, capture_output=True, text=True)
                assert bad.returncode == 3 and "REPLAY_LAYOUT_MISMATCH" in bad.stderr, bad.stderr
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    print("AB-076 recorded route replayed with 0 divergences; layout mismatch rejected; trace redacted")


if __name__ == "__main__":
    main()
