import { describe, it, expect, afterEach } from "vitest";
import { isOnlineNow, isNetworkError } from "@/lib/connectivity";

const setOnline = (v: boolean) => Object.defineProperty(navigator, "onLine", { configurable: true, value: v });

describe("connectivity", () => {
  afterEach(() => setOnline(true));

  it("isOnlineNow follows navigator.onLine", () => {
    setOnline(true); expect(isOnlineNow()).toBe(true);
    setOnline(false); expect(isOnlineNow()).toBe(false);
  });

  it("everything is a network error while definitely offline", () => {
    setOnline(false);
    expect(isNetworkError(new Error("anything at all"))).toBe(true);
  });

  it("recognises transport failures across engines and wrappers", () => {
    setOnline(true);
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);        // Chromium
    expect(isNetworkError(new TypeError("Load failed"))).toBe(true);            // WebKit / iOS
    expect(isNetworkError({ message: "TypeError: Failed to fetch", code: "" })).toBe(true); // PostgREST-wrapped plain object
    expect(isNetworkError(Object.assign(new Error("x"), { name: "AuthRetryableFetchError" }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isNetworkError("Network request failed")).toBe(true);
  });

  it("does NOT swallow real errors as 'offline'", () => {
    setOnline(true);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isNetworkError({ message: "new row violates row-level security policy", code: "42501" })).toBe(false);
    expect(isNetworkError(new Error("Your partner needs to open DuoSpace once to finish secure setup."))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});
