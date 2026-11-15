# Accessibility and browser compatibility audit (AB-099, partial)

**Date:** 2026-11-15. **Build:** main after PR #111 plus this branch. **Content:** synthetic local demo (`pnpm dev`), providers off.

## What was tested (automated, real browsers)

`tests/accessibility/test_axe_audit.py` (CI job `accessibility / axe WCAG 2.2 AA (<engine>)`):

- **axe-core 4.10.3**, tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, `best-practice`.
- **Pages:** `/bills`, a full bill version reader page (interactive reader, citations, tour and session controls), `/learn`, `/about`, `/privacy`, `/accessibility` and a 404 page.
- **Modes:** 320 px light (equivalent to 400 % zoom of 1280 px, WCAG 1.4.10 reflow), 1280 px light, 1280 px dark preference, forced colors with light and with dark system palettes. Every mode uses reduced motion. Each page is also checked for horizontal scrolling.
- **Keyboard walkthrough** on the bill page at 320 and 1280 px. Every Tab stop must show a visible focus indicator (outline or box-shadow), be on screen and have an accessible name, and the cycle must have at least 5 stops. Observed: 23 stops, skip link first, no defects.
- **Engines:** Chromium (local Google Chrome plus CI Chromium); Firefox and WebKit in CI. Forced colors run only in Chromium because Playwright emulates them only there. The keyboard walkthrough is skipped in WebKit, which does not Tab to links by default.

## Findings

| Finding | Status |
| --- | --- |
| axe `color-contrast` failures in forced-colors + dark palette | **False positive.** axe reads author colors (#18263b on #000), but the computed paint is system colors (white on black). In forced-colors mode the rule is replaced by a check that forced colors are applied and text differs from the background. |
| All other axe rules, all pages and modes | 0 violations |
| Reflow at 320 px | No horizontal scroll on any page |
| Keyboard focus | No missing focus indicator, off-screen focus or unnamed control |

No critical access defect was found in core reading, sources, tours or controls in the tested engines.

## Not tested (explicit gaps)

- Screen readers (NVDA, JAWS, VoiceOver, TalkBack, Orca): no assistive technology was available to the agent.
- Physical devices, iOS Safari, Android Chrome and macOS Safari. Playwright WebKit on Linux is not Safari.
- Live AI answer streaming, speech playback, captions with real audio, and microphone flows (providers are off).
- The 3D character stage (not integrated in the reader yet).
- Publisher admin pages (they need an HTTPS origin and an identity provider).
- Cognitive and plain-language review, which needs human judgement.
