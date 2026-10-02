import { describe, it, expect, beforeEach } from "vitest";
import { readPersistedSession } from "@/lib/persistedSession";

const KEY = "sb-abcdefgh-auth-token";
const user = { id: "u-1", email: "a@b.c", created_at: "2026-01-01T00:00:00Z" };

describe("readPersistedSession", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when nothing is stored (never signed in / signed out)", () => {
    expect(readPersistedSession()).toBeNull();
  });

  it("reads the user out of supabase-js's stored session synchronously", () => {
    localStorage.setItem(KEY, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1, user }));
    const s = readPersistedSession();
    expect(s?.user.id).toBe("u-1");
    expect(s?.hasRefreshToken).toBe(true);
  });

  it("reports a session without a refresh token as not re-validatable", () => {
    localStorage.setItem(KEY, JSON.stringify({ access_token: "a", user }));
    expect(readPersistedSession()?.hasRefreshToken).toBe(false);
  });

  it("understands the older { currentSession } wrapper", () => {
    localStorage.setItem(KEY, JSON.stringify({ currentSession: { refresh_token: "r", user } }));
    expect(readPersistedSession()?.user.id).toBe("u-1");
  });

  it("ignores unrelated keys and survives corrupt JSON", () => {
    localStorage.setItem("something-else", JSON.stringify({ user }));
    localStorage.setItem(KEY, "{not json");
    expect(readPersistedSession()).toBeNull();
  });

  it("ignores a stored value with no user id", () => {
    localStorage.setItem(KEY, JSON.stringify({ refresh_token: "r", user: {} }));
    expect(readPersistedSession()).toBeNull();
  });
});
