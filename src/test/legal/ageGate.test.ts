import { describe, expect, it } from "vitest";
import {
  AGE_BLOCK_KEY, AGE_BLOCK_MS, ageFromDob, ageGateMetadata, checkAge, isBlocked, recordBlock,
} from "@/lib/legal/ageGate";

const NOW = new Date("2026-10-02T12:00:00Z");

describe("ageFromDob", () => {
  it("counts whole years and respects the birthday", () => {
    expect(ageFromDob("2008-10-02", NOW)).toBe(18);
    expect(ageFromDob("2008-10-03", NOW)).toBe(17);
    expect(ageFromDob("2000-01-01", NOW)).toBe(26);
  });
  it("rejects malformed, impossible, future and absurd dates", () => {
    for (const bad of ["", "2000-1-1", "2001-02-31", "2027-01-01", "1800-01-01", "abc"]) {
      expect(ageFromDob(bad, NOW)).toBeNull();
    }
  });
});

describe("checkAge", () => {
  it("passes exactly at the minimum age and fails one day short", () => {
    expect(checkAge("2008-10-02", NOW, 18)).toEqual({ ok: true });
    expect(checkAge("2008-10-03", NOW, 18)).toEqual({ ok: false, reason: "too_young" });
  });
  it("reports invalid input separately", () => {
    expect(checkAge("nope", NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("device block", () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
  it("blocks retries for 24h then releases", () => {
    const s = mem();
    expect(isBlocked(s, 1000)).toBe(false);
    recordBlock(s, 1000);
    expect(s.getItem(AGE_BLOCK_KEY)).toBe("1000");
    expect(isBlocked(s, 1000 + AGE_BLOCK_MS - 1)).toBe(true);
    expect(isBlocked(s, 1000 + AGE_BLOCK_MS)).toBe(false);
  });
  it("never throws when storage is missing", () => {
    expect(isBlocked(null)).toBe(false);
    expect(() => recordBlock(null)).not.toThrow();
  });
});

describe("metadata", () => {
  it("records that the gate passed and never contains a date of birth", () => {
    const meta = ageGateMetadata(NOW);
    expect(meta.age_gate.confirmed_at).toBe(NOW.toISOString());
    expect(JSON.stringify(meta)).not.toMatch(/dob|birth/i);
  });
});
