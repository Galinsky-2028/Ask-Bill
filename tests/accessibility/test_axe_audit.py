"""AB-099 automated accessibility audit: axe-core WCAG 2.2 AA + keyboard walkthrough in real Chromium.

Runs the synthetic local demo (no providers, no network). Fails on any axe violation or keyboard
focus defect. In forced-colors mode axe's color-contrast rule reads author colors instead of the
system colors the browser actually paints, so that one rule is replaced by a computed-style check.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
AXE = (ROOT / "node_modules/axe-core/axe.min.js").read_text()
TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]
PAGES = ["/bills", "/learn", "/about", "/privacy", "/accessibility", "/no-such-page"]
MODES = [  # (width, color scheme, forced colors)
    (320, "light", "none"), (1280, "light", "none"), (1280, "dark", "none"), (1280, "dark", "active"), (1280, "light", "active"),
]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def axe_violations(page, forced):
    page.add_script_tag(content=AXE)
    rules = {"color-contrast": {"enabled": forced != "active"}}
    return page.evaluate(
        "async ([tags, rules]) => (await axe.run(document, {runOnly: {type: 'tag', values: tags}, rules}))"
        ".violations.map(v => ({id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map(n => n.target.join(' '))}))",
        [TAGS, rules])


def forced_colors_painted(page):
    return page.evaluate("""() => {
      const s = getComputedStyle(document.body);
      return matchMedia('(forced-colors: active)').matches && s.color !== s.backgroundColor;
    }""")


def keyboard_problems(page):
    seen, problems = [], []
    for _ in range(120):
        page.keyboard.press("Tab")
        info = page.evaluate("""() => {
          const e = document.activeElement; if (!e || e === document.body) return null;
          const s = getComputedStyle(e), r = e.getBoundingClientRect();
          const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.title || '').trim();
          return {key: e.tagName + '#' + e.id + ':' + name.slice(0, 40),
            visible: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none',
            inView: r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0,
            named: !!(name || e.labels?.length || e.getAttribute('aria-labelledby'))};
        }""")
        if info is None:
            continue
        if info["key"] in seen:
            break
        seen.append(info["key"])
        for flag, label in (("visible", "no visible focus"), ("inView", "focus off screen"), ("named", "no accessible name")):
            if not info[flag]:
                problems.append(f"{label}: {info['key']}")
    return seen, problems


def main():
    engine = os.environ.get("ASK_BILL_A11Y_ENGINE", "chromium")
    assert engine in ("chromium", "firefox", "webkit"), engine
    # Playwright emulates forced colors only in Chromium. WebKit does not move focus to links
    # with Tab by default (platform setting), so the keyboard walkthrough runs on Chromium/Firefox.
    modes = MODES if engine == "chromium" else [m for m in MODES if m[2] == "none"]
    keyboard = engine != "webkit"
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(["node", "apps/web/application/start.mjs", "--demo"], cwd=ROOT,
                            env={**os.environ, "PORT": str(port), "ASK_BILL_STAGE": "development"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    failures = []
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/health/live", timeout=0.3)
                break
            except Exception:
                if proc.poll() is not None:
                    raise RuntimeError(proc.stderr.read())
                time.sleep(0.1)
        binary = None
        if engine == "chromium":
            binary = "/usr/bin/chromium" if Path("/usr/bin/chromium").exists() else os.environ.get("ASK_BILL_CHROME")
        with sync_playwright() as playwright:
            browser = getattr(playwright, engine).launch(headless=True, executable_path=binary)
            probe = browser.new_page()
            probe.goto(base + "/bills")
            versions = sorted({h for h in probe.eval_on_selector_all("a[href]", "e => e.map(x => x.getAttribute('href'))") if "/versions/" in h})
            probe.close()
            assert versions, "demo catalog must link a bill version"
            pages = PAGES + versions[:1]
            for width, scheme, forced in modes:
                options = {"forced_colors": forced} if engine == "chromium" else {}
                context = browser.new_context(viewport={"width": width, "height": 800}, color_scheme=scheme,
                                              reduced_motion="reduce", bypass_csp=True, **options)
                page = context.new_page()
                for path in pages:
                    page.goto(base + path)
                    mode = f"{width}px/{scheme}/forced-{forced} {path}"
                    for v in axe_violations(page, forced):
                        failures.append(f"{mode}: axe {v['id']} ({v['impact']}) {v['targets']}")
                    if forced == "active" and not forced_colors_painted(page):
                        failures.append(f"{mode}: forced colors not applied")
                    if page.evaluate("document.documentElement.scrollWidth > innerWidth"):
                        failures.append(f"{mode}: horizontal scroll (reflow failure)")
                if keyboard and forced == "none" and scheme == "light":
                    page.goto(base + versions[0])
                    stops, problems = keyboard_problems(page)
                    if len(stops) < 5:
                        failures.append(f"{width}px keyboard: only {len(stops)} tab stops")
                    failures += [f"{width}px keyboard: {p}" for p in problems]
                context.close()
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    if failures:
        raise AssertionError("Accessibility audit failures:\n" + "\n".join(failures))
    print(f"AB-099 axe WCAG 2.2 AA audit passed in {engine}: {len(PAGES) + 1} pages x {len(modes)} modes, keyboard={keyboard}")


if __name__ == "__main__":
    main()
