# Map bug-fix pass (v3.22.44)
Only src/pages/MapView.tsx changed (+ src/test/mapViewFixes.test.ts, version stamps).
Not verified on a device: tile fallback switching (needs a real blocked/failed provider), retina zoom-to-max, back behaviour from a push-opened /map, fullscreen controls. Test those on a phone.
Left as is: Home picker (HomePlacePanel) and trip cards logic looked sound; Voyager is still OSM + CSS filter (CARTO needs a key).

Also in 3.22.44: Satellite place-name overlay; start-trip pill hidden when inside the Home circle. Check on device: labels visible and not blurry at high zoom.
