# Handoff: Surprise section (blur + blank imported zips)

## Root cause of the blank white zip
Imported/pasted pages had `<base href>` stripped (importer + builder). The Subway Surfers zip is a lone
index.html that loads everything (4399.z.js, master-loader.js, game .part files) relative to a jsDelivr base,
so every request went nowhere -> blank frame.

## Changes
- surpriseDocument.ts: ImportShell.baseHref + safeBaseHref (absolute http/https only); builder emits `<base>`
  before any URL; raw pasted documents keep their base; lint no longer calls base-relative files "missing".
  Runtime hardening for opaque-origin frame: document.cookie, indexedDB, history.pushState/replaceState no longer
  throw at boot; `#hash` links no longer navigate the frame away when a base exists.
- surpriseImport.ts: base-href pages keep script ORDER and position (config script must precede loader); files in
  the zip are inlined in place, others resolve via the base; no false "not found" noise; warns it needs internet.
- CodeSurpriseFrame.tsx: spinner while loading, "still loading" note after 15s (no more bare white box).
- Blur: SurpriseReveal/Editor set `html[data-surprise-open]`; index.css disables ALL backdrop-filter while a
  surprise/preview is open. Removed blur(1px) particles and mix-blend-overlay in the reveal card.
- Test: new cases in src/test/surpriseDocument.test.ts.

## Verified here
Builder output + runtime syntax checked in Node. NOT run: vitest, tsc, build (no node_modules/network).
## Needs real device
- Blur fix (cause is Android-WebView-specific; the backdrop-filter kill-switch is a defensive fix).
- The game itself: needs internet; Unity inside a sandboxed iframe is untested. If it still stays blank, send the
  "Preview error" toast text.
