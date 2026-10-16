import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  computeMediaCap, isQuotaError, requestPersistentStorage, getStorageEstimate,
  MIN_MEDIA_CAP_BYTES, _resetStoragePersistenceForTests,
} from "@/lib/storagePersistence";

const MB = 1024 * 1024;
const HARD = 400 * MB;

describe("computeMediaCap", () => {
  it("keeps the hard cap when the quota is unknown", () => {
    expect(computeMediaCap(HARD, null)).toBe(HARD);
    expect(computeMediaCap(HARD, undefined)).toBe(HARD);
    expect(computeMediaCap(HARD, 0)).toBe(HARD);
    expect(computeMediaCap(HARD, NaN)).toBe(HARD);
  });
  it("keeps the hard cap when half the quota is larger", () => {
    expect(computeMediaCap(HARD, 10 * 1024 * MB)).toBe(HARD);
  });
  it("shrinks to half the quota when that is smaller than the hard cap", () => {
    expect(computeMediaCap(HARD, 300 * MB)).toBe(150 * MB);
  });
  it("never goes below the floor", () => {
    expect(computeMediaCap(HARD, 20 * MB)).toBe(MIN_MEDIA_CAP_BYTES);
  });
});

describe("isQuotaError", () => {
  it("recognises the standard and the Firefox names", () => {
    expect(isQuotaError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isQuotaError(new Error("x"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe("requestPersistentStorage / getStorageEstimate", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "storage");
  const setStorage = (v: unknown) => Object.defineProperty(globalThis.navigator, "storage", { value: v, configurable: true });

  beforeEach(() => _resetStoragePersistenceForTests());
  afterEach(() => {
    if (original) Object.defineProperty(globalThis.navigator, "storage", original);
    else delete (globalThis.navigator as unknown as Record<string, unknown>).storage;
  });

  it("returns null when the API is missing", async () => {
    setStorage(undefined);
    expect(await requestPersistentStorage()).toBeNull();
    expect(await getStorageEstimate()).toEqual({ usage: null, quota: null });
  });

  it("does not ask again when already persistent", async () => {
    const persist = vi.fn();
    setStorage({ persisted: async () => true, persist });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("asks once per launch and reports a refusal", async () => {
    const persist = vi.fn(async () => false);
    setStorage({ persisted: async () => false, persist });
    expect(await requestPersistentStorage()).toBe(false);
    expect(await requestPersistentStorage()).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("never throws when the API does", async () => {
    setStorage({ persisted: async () => { throw new Error("boom"); }, persist: async () => true });
    expect(await requestPersistentStorage()).toBeNull();
  });

  it("reads usage and quota", async () => {
    setStorage({ estimate: async () => ({ usage: 5, quota: 100 }) });
    expect(await getStorageEstimate()).toEqual({ usage: 5, quota: 100 });
  });
});
