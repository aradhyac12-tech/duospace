import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pulseMiniBar } from "@/lib/music/miniLanding";

describe("pulseMiniBar", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("pulses the mini bar element once", () => {
    const el = document.createElement("div");
    el.setAttribute("data-groic-mini-bar", "");
    const animate = vi.fn();
    (el as unknown as { animate: unknown }).animate = animate;
    document.body.appendChild(el);
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    pulseMiniBar();
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("does nothing under reduced motion", () => {
    const el = document.createElement("div");
    el.setAttribute("data-groic-mini-bar", "");
    const animate = vi.fn();
    (el as unknown as { animate: unknown }).animate = animate;
    document.body.appendChild(el);
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    pulseMiniBar();
    expect(animate).not.toHaveBeenCalled();
  });

  it("is safe when the bar is not on screen or animate() is unsupported", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    expect(() => pulseMiniBar()).not.toThrow();
    const el = document.createElement("div");
    el.setAttribute("data-groic-mini-bar", "");
    document.body.appendChild(el);
    expect(() => pulseMiniBar()).not.toThrow();
  });
});
