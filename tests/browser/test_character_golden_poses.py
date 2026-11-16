"""AB-060/AB-063 runtime side: golden-pose visual regression and WebGL 2 / WebGPU parity.

Renders the *candidate* asset (not approved art) at fixed clip times through the production stage
code, compares against checked-in goldens, checks the two backends agree, and proves the face layer
(blink + gaze) visibly changes the eyes. Regenerate goldens deliberately with ASK_BILL_UPDATE_GOLDEN=1
(WebGL 2 backend) after an intentional asset or renderer change, and review the PNGs in the PR.
"""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests/fixtures/character-golden"
POSES = [("Idle", 0.0), ("Point", 0.6), ("Talk", 0.3), ("WalkFunny", 0.4)]
FACE = {"blink": 1, "gaze": {"x": 0.8, "y": 0.3}}
ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader",
        "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
GOLDEN_TOLERANCE = 0.03   # share of foreground pixels allowed to differ (rasterizer noise)
PARITY_TOLERANCE = 0.12   # WebGPU node materials vs WebGL 2 shaders differ slightly in shading
FACE_MINIMUM = 0.004      # blink + gaze must visibly change the render

DIFF = """async ([a, b]) => {
  const load = src => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
  const [x, y] = await Promise.all([load(a), load(b)]);
  const px = img => { const c = document.createElement('canvas'); c.width = 220; c.height = 260;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, 220, 260).data; };
  const p = px(x), q = px(y); let fg = 0, diff = 0;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 8 && q[i + 3] < 8) continue; fg++;
    const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]), Math.abs(p[i + 3] - q[i + 3]));
    if (d > 48) diff++;
  }
  return {foreground: fg, ratio: fg ? diff / fg : 1};
}"""

SNAP = """async ([clip, time, preference, face]) => {
  const {renderPoseSnapshot} = await import('/browser/packages/character/renderer/stage.mjs');
  const {loadModules} = await import('/experience/character-stage.mjs');
  return renderPoseSnapshot({win: window, loadModules, assetUrl: '/experience/assets/bill.glb', clip, time, preference, face});
}"""


def main():
    update = os.environ.get("ASK_BILL_UPDATE_GOLDEN") == "1"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(["node", "apps/web/application/start.mjs", "--demo"], cwd=ROOT,
                            env={**os.environ, "PORT": str(port), "ASK_BILL_STAGE": "development", "ASK_BILL_CHARACTER_STAGE": "true"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    results = {}
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
            # Full Chromium (new headless), not the headless shell, so WebGPU/Vulkan are available.
            options = {"executable_path": binary} if binary else {"channel": "chromium"}
            browser = playwright.chromium.launch(headless=True, args=ARGS, **options)
            page = browser.new_page()
            page.goto(base + "/about")
            GOLDEN.mkdir(parents=True, exist_ok=True)
            failures = []
            for clip, t in POSES:
                gl = page.evaluate(SNAP, [clip, t, "webgl2", {}])
                gpu = page.evaluate(SNAP, [clip, t, "webgpu", {}])
                assert gl["backend"] == "webgl2" and gpu["backend"] == "webgpu", (gl["backend"], gpu["backend"])
                path = GOLDEN / f"{clip}-{t}.png"
                if update:
                    path.write_bytes(base64.b64decode(gl["dataUrl"].split(",", 1)[1]))
                golden = "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()
                vs_golden = page.evaluate(DIFF, [gl["dataUrl"], golden])
                parity = page.evaluate(DIFF, [gl["dataUrl"], gpu["dataUrl"]])
                results[f"{clip}@{t}"] = {"golden": round(vs_golden["ratio"], 4), "parity": round(parity["ratio"], 4), "foreground": vs_golden["foreground"]}
                if vs_golden["foreground"] < 2000:
                    failures.append(f"{clip}: character not visible ({vs_golden['foreground']} px)")
                if vs_golden["ratio"] > GOLDEN_TOLERANCE:
                    failures.append(f"{clip}: {vs_golden['ratio']:.3f} of pixels differ from golden")
                    # Emit the render so a reviewer can inspect it (and deliberately adopt it as the new golden).
                    print(f"GOLDEN-CANDIDATE {path.name} {gl['dataUrl'].split(',', 1)[1]}")
                if parity["ratio"] > PARITY_TOLERANCE:
                    failures.append(f"{clip}: WebGPU/WebGL 2 parity {parity['ratio']:.3f}")
            neutral = page.evaluate(SNAP, ["Idle", 0.0, "webgl2", {}])
            blinking = page.evaluate(SNAP, ["Idle", 0.0, "webgl2", FACE])
            face = page.evaluate(DIFF, [neutral["dataUrl"], blinking["dataUrl"]])
            results["face-layer"] = round(face["ratio"], 4)
            if face["ratio"] < FACE_MINIMUM:
                failures.append(f"face layer had no visible effect ({face['ratio']:.4f})")
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    print(json.dumps(results, indent=1))
    if failures:
        raise AssertionError("\n".join(failures))
    print("AB-060/AB-063 golden poses, backend parity and face layer passed" + (" (goldens updated)" if update else ""))


if __name__ == "__main__":
    main()
