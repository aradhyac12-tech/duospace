import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("music page: pull-to-refresh + Back from search", () => {
  const page = readFileSync("src/pages/Groic.tsx", "utf8");
  const hook = readFileSync("src/hooks/usePullToRefresh.ts", "utf8");
  it("Back clears an active search before leaving Music (chevron AND Android back)", () => {
    expect(page).toMatch(/useBackHandler\(searching, \(\) => \{ clearSearch\(\); \}\)/);
    expect(page).toMatch(/if \(!goBackInMusic\(\)\) navigate\(-1\)/);
  });
  it("pull-to-refresh moves the DOM directly (no per-frame React state) and only owns vertical pulls at scrollTop 0", () => {
    expect(hook).toMatch(/passive: false/);
    expect(hook).toMatch(/sc\.scrollTop > 0/);
    expect(hook).toMatch(/Math\.abs\(dx\) > Math\.abs\(dy\)/);
    expect(hook).not.toMatch(/useState/);
  });
});
