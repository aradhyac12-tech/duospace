// FIX AUDIT #1: Comprehensive test setup — mocks all browser APIs used by DuoSpace.
import "@testing-library/jest-dom";
import { vi, afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// ── Cleanup after each test to prevent state leaks between tests ──────────────
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});

// ── matchMedia (used by Tailwind responsive hooks) ────────────────────────────
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// ── ResizeObserver (used by useVirtualList and chat scroll container) ─────────
class MockResizeObserver {
  observe()    {}
  unobserve()  {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = MockResizeObserver;

// ── IntersectionObserver (used by media lazy-loading) ────────────────────────
class MockIntersectionObserver {
  observe()    {}
  unobserve()  {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;

// ── Web Crypto (used by useE2E / crypto.ts) ───────────────────────────────────
// Node 18+ includes webcrypto natively but jsdom may not expose it on `window`.
if (!window.crypto?.subtle) {
  const { webcrypto } = await import("node:crypto");
  Object.defineProperty(window, "crypto", {
    value: webcrypto,
    writable: false,
  });
}

// ── navigator.onLine ──────────────────────────────────────────────────────────
Object.defineProperty(navigator, "onLine", {
  writable: true,
  value: true,
});

// ── localStorage (jsdom provides this, but clear between tests) ───────────────
beforeEach(() => {
  try { localStorage.clear(); } catch { /* noop */ }
  try { sessionStorage.clear(); } catch { /* noop */ }
});

// ── Supabase client mock — prevents real network calls in unit tests ──────────
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser:    vi.fn().mockResolvedValue({ data: { user: null },    error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      refreshSession: vi.fn().mockResolvedValue({ error: null }),
      signOut:        vi.fn().mockResolvedValue({ error: null }),
    },
    from: vi.fn().mockReturnValue({
      select:  vi.fn().mockReturnThis(),
      insert:  vi.fn().mockResolvedValue({ data: null, error: null }),
      update:  vi.fn().mockReturnThis(),
      delete:  vi.fn().mockReturnThis(),
      eq:      vi.fn().mockReturnThis(),
      order:   vi.fn().mockReturnThis(),
      limit:   vi.fn().mockResolvedValue({ data: [], error: null }),
      single:  vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    channel: vi.fn().mockReturnValue({
      on:        vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  },
}));

