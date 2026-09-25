import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = vi.hoisted(() => {
  const state = {
    server: null as null | { message_sound: string; call_ringtone: string },
    upserts: [] as Array<Record<string, unknown>>,
    failUpsert: null as null | { code?: string; message: string },
    gate: null as null | Promise<void>,
  };
  const client = {
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        if (state.gate) await state.gate;
        if (state.failUpsert) return { error: state.failUpsert };
        state.upserts.push(row);
        state.server = { message_sound: String(row.message_sound), call_ringtone: String(row.call_ringtone) };
        return { error: null };
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.server, error: null }) }) }),
    }),
  };
  return { state, client };
});

vi.mock("@/integrations/supabase/appClient", () => ({ supabase: fake.client }));
vi.mock("@/lib/telemetry", () => ({ logWarn: () => {} }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web" } }));

import {
  getActiveSoundPrefs, getLocalSoundPrefs, saveSoundPrefs, setActiveSoundUser, syncSoundPrefs,
} from "@/lib/notificationSoundPrefs";

const U = "user-1";

beforeEach(() => {
  localStorage.clear();
  fake.state.server = null;
  fake.state.upserts = [];
  fake.state.failUpsert = null;
  fake.state.gate = null;
  setActiveSoundUser(null);
});

describe("notification sound prefs (local-first)", () => {
  it("a failed server save keeps the choice on the device, marked dirty", async () => {
    fake.state.failUpsert = { code: "23514", message: "check violation" };
    const res = await saveSoundPrefs(U, { messageSound: "bell" });
    expect(res.ok).toBe(false);
    expect(getLocalSoundPrefs(U)).toEqual({ messageSound: "bell", callRingtone: "classic", dirty: true });
    expect(getActiveSoundPrefs().messageSound).toBe("bell"); // in-app playback already uses it
  });

  it("sync retries a dirty choice and clears the flag once it lands", async () => {
    fake.state.failUpsert = { message: "offline" };
    await saveSoundPrefs(U, { callRingtone: "retro" });
    fake.state.failUpsert = null;
    await syncSoundPrefs(U);
    expect(fake.state.upserts.at(-1)).toMatchObject({ user_id: U, call_ringtone: "retro" });
    expect(getLocalSoundPrefs(U).dirty).toBe(false);
  });

  it("a dirty local choice is never overwritten by the server's older value", async () => {
    fake.state.server = { message_sound: "pop", call_ringtone: "urgent" };
    fake.state.failUpsert = { message: "offline" };
    await saveSoundPrefs(U, { messageSound: "glass" });
    fake.state.failUpsert = null;
    const resolved = await syncSoundPrefs(U);
    expect(resolved.messageSound).toBe("glass");
  });

  it("adopts the server value when nothing is pending (changed on another device)", async () => {
    fake.state.server = { message_sound: "harp", call_ringtone: "waltz" };
    const resolved = await syncSoundPrefs(U);
    expect(resolved).toEqual({ messageSound: "harp", callRingtone: "waltz" });
    expect(getLocalSoundPrefs(U).dirty).toBe(false);
  });

  it("a pick made while a save is in flight stays dirty and is sent next", async () => {
    let release!: () => void;
    fake.state.gate = new Promise<void>((r) => { release = r; });
    const first = saveSoundPrefs(U, { messageSound: "bell" });
    await new Promise((r) => setTimeout(r, 0)); // request #1 is now out, held at the gate
    const second = saveSoundPrefs(U, { messageSound: "droplet" });
    release();
    await Promise.all([first, second]);
    expect(fake.state.server?.message_sound).toBe("droplet");
    expect(getLocalSoundPrefs(U)).toEqual({ messageSound: "droplet", callRingtone: "classic", dirty: false });
  });

  it("unknown ids (stale storage, older/newer server) fall back to the defaults", async () => {
    localStorage.setItem(`duo:notif-sounds:v1:${U}`, JSON.stringify({ messageSound: "gone", callRingtone: "nope", dirty: false }));
    expect(getLocalSoundPrefs(U)).toEqual({ messageSound: "classic", callRingtone: "classic", dirty: false });
  });

  it("choices are per user", async () => {
    await saveSoundPrefs("a", { messageSound: "tick" });
    expect(getLocalSoundPrefs("b").messageSound).toBe("classic");
  });
});
