import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/appClient", () => ({ supabase: {} }));
vi.mock("@/lib/telemetry", () => ({ logWarn: () => {} }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web" } }));

import { startIncomingRingtone, startRingtoneLoop, stopRingtoneLoop } from "@/lib/sounds";

const made: Array<{ src: string; loop: boolean; paused: boolean }> = [];
class FakeAudio {
  src: string; loop = false; paused = false; preload = "";
  constructor(src: string) { this.src = src; made.push(this); }
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  made.length = 0;
  (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;
  stopRingtoneLoop();
});

describe("incoming-call ringtone (in-app)", () => {
  it("plays the chosen ringtone file, looping, immediately when there is no native ringer to defer to", () => {
    startIncomingRingtone("retro");
    expect(made.length).toBe(1);
    expect(made[0].src).toBe("/sounds/retro_call.m4a");
    expect(made[0].loop).toBe(true);
    stopRingtoneLoop();
    expect(made[0].paused).toBe(true);
  });

  it("stays silent when the OS is already ringing it, rings in-app when that is false or unknown", async () => {
    startIncomingRingtone("bells", async () => true);
    await sleep(1100);
    expect(made.length).toBe(0);

    startIncomingRingtone("bells", async () => null);
    await sleep(1100);
    expect(made.length).toBe(1);
    expect(made[0].src).toBe("/sounds/bells_call.m4a");
    stopRingtoneLoop();
  });

  it("answering during the check window cancels the ring", async () => {
    startIncomingRingtone("digital", async () => false);
    stopRingtoneLoop(); // call answered / declined before the check fired
    await sleep(1100);
    expect(made.length).toBe(0);
  });

  it("the caller's ringback (no id) never touches the ringtone files", () => {
    startRingtoneLoop();
    expect(made.length).toBe(0);
    stopRingtoneLoop();
  });
});
