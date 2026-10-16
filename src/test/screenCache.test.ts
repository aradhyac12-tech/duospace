import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const write = vi.fn(async () => {});
const remove = vi.fn(async () => {});
let sessionUser: string | null = "u1";

vi.mock("@/lib/localDb", () => ({
  collectionStore: {
    read: vi.fn(async () => null),
    write: (...a: unknown[]) => (write as (...x: unknown[]) => Promise<void>)(...a),
    remove: (...a: unknown[]) => (remove as (...x: unknown[]) => Promise<void>)(...a),
  },
}));
vi.mock("@/lib/persistedSession", () => ({
  readPersistedSession: () => (sessionUser ? { user: { id: sessionUser } } : null),
}));

import { writeScreenCache, flushScreenCache, clearScreenCache } from "@/lib/screenCache";

describe("screenCache write-behind", () => {
  beforeEach(() => { vi.useFakeTimers(); write.mockClear(); remove.mockClear(); sessionUser = "u1"; });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces rapid writes into one (the latest)", async () => {
    writeScreenCache("u1", "shayari", { n: 1 });
    writeScreenCache("u1", "shayari", { n: 2 });
    await vi.advanceTimersByTimeAsync(900);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("u1", "shayari", { n: 2 });
  });

  it("flushScreenCache writes pending snapshots immediately and only once", async () => {
    writeScreenCache("u1", "us", { a: 1 });
    writeScreenCache("u1", "gallery", { b: 2 });
    await flushScreenCache();
    expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(2); // timers were cancelled, no double write
  });

  it("flushes when the page becomes hidden", async () => {
    writeScreenCache("u1", "us", { a: 1 });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledWith("u1", "us", { a: 1 });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("drops a pending write after sign-out", async () => {
    writeScreenCache("u1", "us", { a: 1 });
    sessionUser = null;
    await flushScreenCache();
    expect(write).not.toHaveBeenCalled();
  });

  it("clearScreenCache cancels a pending write", async () => {
    writeScreenCache("u1", "us", { a: 1 });
    await clearScreenCache("u1", "us");
    await flushScreenCache();
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("u1", "us");
  });

  it("ignores writes without a user", async () => {
    writeScreenCache(null, "us", { a: 1 });
    await flushScreenCache();
    expect(write).not.toHaveBeenCalled();
  });
});
