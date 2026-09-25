import { describe, it, expect } from "vitest";
import { parseOriginPolicy, isOriginAllowed, originPolicyWarnings, OriginConfigError } from "../src/origin.js";

const PROD = "production";

describe("signaling origin policy", () => {
  it("production with an EMPTY allowlist refuses to start (no silent allow-all)", () => {
    expect(() => parseOriginPolicy("", PROD)).toThrow(OriginConfigError);
    expect(() => parseOriginPolicy(undefined, PROD)).toThrow(/empty in production/);
  });

  it("production rejects an origin that is not listed", () => {
    const p = parseOriginPolicy("https://app.duospace.example,https://localhost,capacitor://localhost", PROD);
    expect(isOriginAllowed(p, "https://evil.example")).toBe(false);
    expect(isOriginAllowed(p, "")).toBe(false);
    expect(isOriginAllowed(p, undefined)).toBe(false);
    expect(isOriginAllowed(p, "http://localhost")).toBe(false); // scheme matters
  });

  it("accepts the Capacitor Android and iOS WebView origins when listed (case/trailing-slash insensitive)", () => {
    const p = parseOriginPolicy("https://localhost/, CAPACITOR://LOCALHOST", PROD);
    expect(isOriginAllowed(p, "https://localhost")).toBe(true);
    expect(isOriginAllowed(p, "capacitor://localhost")).toBe(true);
    expect(originPolicyWarnings(p)).toEqual([]);
  });

  it("warns when a Capacitor origin is missing", () => {
    const w = originPolicyWarnings(parseOriginPolicy("https://app.example", PROD));
    expect(w.join(" ")).toMatch(/Android/);
    expect(w.join(" ")).toMatch(/iOS/);
  });

  it('"*" is an explicit, deliberate allow-any (and cannot be mixed)', () => {
    const p = parseOriginPolicy("*", PROD);
    expect(isOriginAllowed(p, "https://anything.example")).toBe(true);
    expect(originPolicyWarnings(p)[0]).toMatch(/any website origin/);
    expect(() => parseOriginPolicy("*,https://a.example", PROD)).toThrow(OriginConfigError);
  });

  it("development with an empty list allows any origin, with a warning", () => {
    const p = parseOriginPolicy("", "development");
    expect(isOriginAllowed(p, "http://localhost:5173")).toBe(true);
    expect(originPolicyWarnings(p)[0]).toMatch(/development/);
  });

  it("rejects malformed entries", () => {
    expect(() => parseOriginPolicy("localhost", PROD)).toThrow(/not an origin/);
    expect(() => parseOriginPolicy("https://a.example/path", PROD)).toThrow(/not an origin/);
  });
});
