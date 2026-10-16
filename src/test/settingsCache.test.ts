import { describe, it, expect, beforeEach } from "vitest";
import { readSettingsCache, writeSettingsCache, clearSettingsCache } from "@/lib/settingsCache";
import { getOfflinePref, getOfflinePrefs, setOfflinePref } from "@/lib/offlineSettings";

describe("settingsCache", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips per user and name", () => {
    writeSettingsCache("u1", "hub", { partnerLinked: true, partnerName: "Sam" });
    expect(readSettingsCache<{ partnerName: string }>("u1", "hub")?.partnerName).toBe("Sam");
    expect(readSettingsCache("u2", "hub")).toBeNull();
    expect(readSettingsCache("u1", "other")).toBeNull();
  });

  it("is a no-op without a user id (signed-out / not loaded yet)", () => {
    writeSettingsCache(undefined, "hub", { a: 1 });
    expect(readSettingsCache(undefined, "hub")).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("clearSettingsCache removes only that user's values", () => {
    writeSettingsCache("u1", "hub", { a: 1 });
    writeSettingsCache("u1", "profile-me", { name: "x" });
    writeSettingsCache("u2", "hub", { a: 2 });
    localStorage.setItem("unrelated", "keep");
    clearSettingsCache("u1");
    expect(readSettingsCache("u1", "hub")).toBeNull();
    expect(readSettingsCache("u1", "profile-me")).toBeNull();
    expect(readSettingsCache<{ a: number }>("u2", "hub")?.a).toBe(2);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
});

describe("offlineSettings", () => {
  beforeEach(() => localStorage.clear());

  it("always: history on, media on, Wi-Fi-only off", () => {
    expect(getOfflinePrefs()).toEqual({ chatHistory: true, screenData: true, mediaCache: true, wifiOnlyMedia: false });
  });

  it("history / screens / media stay automatic: old stored switches and setOfflinePref cannot turn them off", () => {
    localStorage.setItem("duo-offline-chat-history", "0");
    setOfflinePref("chatHistory", false);
    setOfflinePref("screenData", false);
    setOfflinePref("mediaCache", false);
    expect(getOfflinePrefs()).toEqual({ chatHistory: true, screenData: true, mediaCache: true, wifiOnlyMedia: false });
  });

  it("Wi-Fi-only media is the one persisted choice (default off)", () => {
    expect(getOfflinePref("wifiOnlyMedia")).toBe(false);
    setOfflinePref("wifiOnlyMedia", true);
    expect(getOfflinePref("wifiOnlyMedia")).toBe(true);
    expect(getOfflinePrefs().wifiOnlyMedia).toBe(true);
    setOfflinePref("wifiOnlyMedia", false);
    expect(getOfflinePref("wifiOnlyMedia")).toBe(false);
    expect(localStorage.getItem("duo-offline-wifi-only-media")).toBeNull();
  });
});
