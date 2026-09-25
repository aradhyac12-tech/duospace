# Surprise import, library and rendering (v3.11.0)

## Using it
Editor → **Import zip / files**. Pick either one `.zip`, or any mix of `.html`, `.css`, `.js`
(plus images/audio the page names). Result lands in the HTML / CSS / JS tabs; the JS tab is empty
when the page has no script. An "Imported …" card lists what was embedded, what wasn't and why.
Big media shows as `ds-asset://aN` tokens in the text areas and is expanded on preview/save.

**Save uploads to my library** (switch, default on) stores every import in `surprise_library`
(private). **Save to library / Update library copy** saves whatever is in the editor. **Library**
lists them; **Use** loads one (asks first if you have unsaved edits). The normal **Save** still
creates the `code_surprises` row that the partner receives — library saves never reach the partner.

## Limits (`SURPRISE_LIMITS` in `src/lib/surpriseDocument.ts`)
1.5 MB per embedded file · 3 MB embedded total · 4.5M characters html+css+js · zip ≤ 25 MB,
≤ 600 files, ≤ 60 MB expanded. Large PNG/JPEG are re-encoded to WebP (≤1600px) when the browser can.

## What is and isn't handled
Handled: `<style>`, `<link rel=stylesheet>` (+ nested `@import`), classic `<script>`/`<script src>`,
`url()`/`src`/`poster`/`srcset`/inline `style`, `<html>`/`<body>` attributes, JS string literals that
are the exact path of an uploaded file. Left as tags: remote stylesheets/scripts, inline/remote
`type=module`, importmaps, JSON-LD. Not handled: ES modules importing local files (skipped with a
reason), `<iframe src=local.html>`, `document.write`, nested pages, non-embeddable file types.

## Files
`surpriseDocument.ts` (builder/runtime/URL normaliser/lint) · `surpriseImport.ts` · `surpriseAssets.ts`
· `surpriseLibrary.ts` · `components/surprise/SurpriseLibraryPanel.tsx` · `CodeSurpriseFrame.tsx` ·
`surpriseEngine.ts` (`ensureSurpriseBody`) · migration `20260920110000_surprise_library.sql`.
