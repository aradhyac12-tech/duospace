import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Static regression checks for the v3.22.44 map pass (MapView needs Leaflet + the whole location stack to render). */
const src = readFileSync(join(process.cwd(), "src/pages/MapView.tsx"), "utf8");

describe("MapView tiles", () => {
  it("keeps the retina layer alive over the whole zoom range (Leaflet lowers layer maxZoom by 1 with detectRetina)", () => {
    expect(src).toMatch(/maxZoom: MAX_ZOOM \+ \(isRetina \? 1 : 0\)/);
  });
  it("every style has a real backup provider with its own credit line", () => {
    const withFallback = src.match(/fallbackUrl: /g) ?? [];
    expect(withFallback.length).toBeGreaterThanOrEqual(3); // street, satellite, voyager (+ the interface field)
    expect(src).toMatch(/fallbackAttribution/);
  });
  it("only falls back after a run of failures, never when offline, and a good tile resets the run", () => {
    expect(src).toMatch(/TILE_ERRORS_BEFORE_FALLBACK = 6/);
    expect(src).toMatch(/navigator\.onLine === false\) return/);
    expect(src).toMatch(/failStreak = 0/);
    expect(src).toMatch(/failStreak < TILE_ERRORS_BEFORE_FALLBACK\) return/);
  });
  it("remembers the chosen map style", () => {
    expect(src).toMatch(/localStorage\.setItem\(MAP_STYLE_KEY, next\)/);
    expect(src).toMatch(/useState<MapStyle>\(readSavedStyle\)/);
  });
});

describe("MapView controls", () => {
  it("blocking overlays sit below the back/style/home controls (they used to cover them)", () => {
    expect(src).not.toMatch(/backdrop-blur-sm z-\[1000\]/);
    expect(src.match(/backdrop-blur-sm z-\[998\]/g)?.length).toBe(2);
  });
  it("back arrow leaves fullscreen first and falls back to /chat on a cold open", () => {
    expect(src).toMatch(/if \(isFullscreen\) \{ setIsFullscreen\(false\); return; \}/);
    expect(src).toMatch(/routerLocation\.key === "default"\) navigate\("\/chat", \{ replace: true \}\)/);
    expect(src).toMatch(/useBackHandler\(isFullscreen/);
  });
  it("fullscreen still shows zoom and recenter", () => {
    expect(src).toMatch(/isFullscreen \? "justify-end" : "justify-between"/);
    expect(src).toMatch(/aria-label="Zoom in"/);
  });
  it("partner marker keeps a coloured dot behind the avatar so a failed image isn't an empty hole", () => {
    expect(src).toMatch(/background:\$\{color\};border:2\.5px solid white[^`]*<\/div>\s*\n\s*\$\{avatarUrl/);
  });
  it("distance never prints 1000 m", () => {
    expect(src).toMatch(/roundedM < 1000/);
  });
});

describe("MapView follow-ups", () => {
  it("Satellite gets a place-name overlay that is removed for other styles", () => {
    expect(src).toMatch(/World_Boundaries_and_Places/);
    expect(src).toMatch(/mapStyle !== "satellite"/);
  });
  it("the heading-home start button is hidden while already inside the Home circle", () => {
    expect(src).toMatch(/insideHome=\{insideHome\}/);
    const cards = readFileSync(join(process.cwd(), "src/components/map/HomeTripCards.tsx"), "utf8");
    expect(cards).toMatch(/hasHome && !insideHome && !ownTrip/);
  });
});
