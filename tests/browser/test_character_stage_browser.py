"""AB-063/AB-077: candidate GLB stage in real Chromium under the production reader CSP.

Proves the optional stage loads same-origin three.js and the candidate asset, animates, reacts to a
trusted source-focus event, can be hidden, stays off under reduced motion, and never affects reading.
This does not validate the art: the asset is an unapproved candidate.
"""
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


GPU_ARGS = {
    # Forced WebGL 2 through SwiftShader.
    "webgl2": ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    # WebGPU through SwiftShader Vulkan (headless Chromium exposes no adapter otherwise).
    "webgpu": ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader",
               "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
}


def main(backend):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(["node", "apps/web/application/start.mjs", "--demo"], cwd=ROOT,
                            env={**os.environ, "PORT": str(port), "ASK_BILL_STAGE": "development", "ASK_BILL_CHARACTER_STAGE": "true",
                                 "ASK_BILL_CHARACTER_BACKEND": "webgl2" if backend == "webgl2" else "auto"},
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
        with sync_playwright() as playwright:
            options = {"executable_path": binary} if binary else {"channel": "chromium"}
            browser = playwright.chromium.launch(headless=True, args=GPU_ARGS[backend], **options)
            probe = browser.new_page()
            probe.goto(base + "/bills")
            version = [h for h in probe.eval_on_selector_all("a[href]", "e => e.map(x => x.getAttribute('href'))") if "/versions/" in h][0]
            probe.close()

            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors, csp = [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: csp.append(m.text) if "Content Security Policy" in m.text else None)
            page.goto(base + version)
            # Poll from the test side: in-page wait_for_function needs eval, which the reader CSP forbids.
            state = None
            for _ in range(240):
                state = page.evaluate("() => document.querySelector('.bill-stage')?.dataset.state ?? null")
                if state and (state == "3d:ready" or state.startswith("off:")):
                    break
                page.wait_for_timeout(250)
            assert state == "3d:ready", f"stage did not become ready: {state}"
            assert page.evaluate("!document.querySelector('.bill-stage').hidden")
            actual = page.evaluate("() => document.querySelector('.bill-stage').dataset.backend")
            assert actual == backend, f"expected {backend} backend, got {actual}"
            assert page.locator(".bill-stage canvas").count() == 1
            assert page.evaluate("document.querySelector('.bill-stage canvas').getAttribute('aria-hidden')") == "true"
            # Trusted reader focus on the first provision: must not throw or move focus.
            page.locator("#bill-search").focus()
            page.evaluate("""() => {
              const reader = document.querySelector('[data-reader]');
              const first = document.querySelector('#bill-document [data-provision-id]');
              document.dispatchEvent(new CustomEvent('askbill:source-focus', {detail: {versionId: reader.dataset.versionId, provisionId: first.dataset.provisionId}}));
              document.dispatchEvent(new CustomEvent('askbill:answer-state', {detail: {phase: 'answering'}}));
              document.dispatchEvent(new CustomEvent('askbill:answer-state', {detail: {phase: 'done'}}));
            }""")
            page.wait_for_timeout(500)
            assert page.evaluate("document.activeElement.id") == "bill-search", "stage must not steal focus"
            assert page.locator("#bill-document [data-provision-id]").count() > 0
            # Follow mode 1: on wide screens the guide panel is sticky, so the inline stage stays in view.
            page.set_viewport_size({"width": 1920, "height": 900})
            page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(600)
            inline = page.evaluate("() => { const r = document.querySelector('.bill-stage').getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }")
            assert inline, "sticky guide panel keeps Bill visible while reading"
            assert page.evaluate("() => document.querySelector('.bill-stage-dock').hidden"), "no dock while the inline slot is visible"
            page.evaluate("() => window.scrollTo(0, 0)")
            page.set_viewport_size({"width": 1280, "height": 800})
            # Hide control removes the stage and is remembered for the session.
            page.get_by_role("button", name="Hide animated Bill").click()
            assert page.locator(".bill-stage").count() == 0
            page.reload()
            page.wait_for_timeout(1500)
            assert page.locator(".bill-stage canvas").count() == 0, "hidden preference must persist in the session"
            assert not errors, errors
            assert not csp, csp
            page.close()

            docked_ctx = browser.new_context(viewport={"width": 1920, "height": 700}, bypass_csp=True)
            docked = docked_ctx.new_page()
            docked.goto(base + version)
            docked.add_style_tag(content=".conversation-panel{position:static!important;top:auto!important}")
            for _ in range(240):
                if docked.evaluate("() => document.querySelector('.bill-stage')?.dataset.state") == "3d:ready":
                    break
                docked.wait_for_timeout(250)
            docked.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
            for _ in range(40):
                if docked.evaluate("() => !!document.querySelector('.bill-stage-dock canvas')"):
                    break
                docked.wait_for_timeout(100)
            assert docked.evaluate("() => !!document.querySelector('.bill-stage-dock canvas')"), "non-sticky layout with a gutter docks Bill"
            geo = docked.evaluate("() => { const d = document.querySelector('.bill-stage-dock').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return {left: d.left, mainRight: m.right}; }")
            assert geo["left"] >= geo["mainRight"], f"dock must sit in the empty gutter, not over content: {geo}"
            docked.evaluate("() => window.scrollTo(0, 0)")
            for _ in range(40):
                if docked.evaluate("() => !!document.querySelector('.bill-stage-canvas canvas')"):
                    break
                docked.wait_for_timeout(100)
            assert docked.evaluate("() => !!document.querySelector('.bill-stage-canvas canvas')"), "stage returns inline"
            docked_ctx.close()

            reduced = browser.new_page(viewport={"width": 1280, "height": 800}, reduced_motion="reduce")
            reduced.goto(base + version)
            reduced.wait_for_timeout(1500)
            assert reduced.locator(".bill-stage canvas").count() == 0, "reduced motion must not start the 3D stage"
            assert reduced.locator("#bill-document [data-provision-id]").count() > 0
            reduced.close()
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    print(f"AB-063/072/077 candidate stage [{backend}]: loads under CSP, reacts, follows into the gutter, hides, honors reduced motion")


if __name__ == "__main__":
    for selected in os.environ.get("ASK_BILL_STAGE_BACKENDS", "webgl2,webgpu").split(","):
        main(selected)
