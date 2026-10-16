/**
 * The selectable sounds are described in several places that cannot share an
 * import (client, Deno edge function, Kotlin, Swift, bundled assets). A sound
 * missing from any one of them fails silently — falls back to "classic", or on
 * Android is dropped because its notification channel doesn't exist. This
 * test makes that drift a build failure instead.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { MESSAGE_SOUNDS, CALL_RINGTONES } from "@/lib/notificationSounds";
import * as edge from "../../supabase/functions/_shared/soundCatalog";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const msgIds = MESSAGE_SOUNDS.map((s) => s.id);
const callIds = CALL_RINGTONES.map((s) => s.id);

/** Text of `val NAME = xxxOf( ... )` up to the closing paren on its own line. */
function kotlinBlock(src: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*\\w+\\(([\\s\\S]*?)\\n\\s*\\)`).exec(src);
  if (!m) throw new Error(`Kotlin block ${name} not found`);
  return m[1];
}
const kotlinIds = (block: string) => Array.from(block.matchAll(/"(\w+)"\s+to\b/g), (m) => m[1]);
const kotlinVibration = (block: string) =>
  Object.fromEntries(
    Array.from(block.matchAll(/"(\w+)"\s+to\s+longArrayOf\(([^)]*)\)/g), (m) => [
      m[1], m[2].split(",").map((n) => Number(n.trim())),
    ]),
  );
const sorted = (xs: string[]) => [...xs].sort();

describe("notification sound catalog stays in sync everywhere", () => {
  it("ids are unique, lowercase, and short enough for the DB shape check", () => {
    for (const ids of [msgIds, callIds]) {
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
  });

  it("client ↔ edge function (send-push normalizers)", () => {
    expect(sorted([...edge.MESSAGE_SOUND_IDS])).toEqual(sorted(msgIds));
    expect(sorted([...edge.CALL_RINGTONE_IDS])).toEqual(sorted(callIds));
    for (const id of msgIds) expect(edge.normalizeMessageSound(id)).toBe(id);
    for (const id of callIds) expect(edge.normalizeCallRingtone(id)).toBe(id);
    expect(edge.normalizeMessageSound("nope")).toBe(edge.DEFAULT_MESSAGE_SOUND);
  });

  it("Android: one notification channel per id, raw names match", () => {
    const src = read("native/android/NotificationChannels.kt");
    const msg = kotlinBlock(src, "MESSAGE_SOUND_VARIANTS");
    const call = kotlinBlock(src, "CALL_SOUND_VARIANTS");
    expect(sorted(kotlinIds(msg))).toEqual(sorted(msgIds));
    expect(sorted(kotlinIds(call))).toEqual(sorted(callIds));
    for (const m of msg.matchAll(/"(\w+)"\s+to\s+Pair\("[^"]*",\s*"(\w+)"\)/g)) expect(m[2]).toBe(`${m[1]}_msg`);
    for (const m of call.matchAll(/"(\w+)"\s+to\s+Pair\("[^"]*",\s*"(\w+)"\)/g)) expect(m[2]).toBe(`${m[1]}_call`);
  });

  it("Android: vibration patterns match what Settings previews (channels + ringing service)", () => {
    const ch = read("native/android/NotificationChannels.kt");
    const svc = read("native/android/CallRingingService.kt");
    const msgVib = kotlinVibration(kotlinBlock(ch, "MESSAGE_VIBRATE_PATTERNS"));
    const callVib = kotlinVibration(kotlinBlock(ch, "CALL_VIBRATE_PATTERNS"));
    const svcVib = kotlinVibration(kotlinBlock(svc, "VIBRATE_PATTERNS"));
    for (const o of MESSAGE_SOUNDS) expect(msgVib[o.id], `message ${o.id}`).toEqual(o.pattern);
    for (const o of CALL_RINGTONES) {
      expect(callVib[o.id], `channel ${o.id}`).toEqual(o.pattern);
      expect(svcVib[o.id], `service ${o.id}`).toEqual(o.pattern);
    }
  });

  it("Android: ringing service knows every ringtone", () => {
    const svc = read("native/android/CallRingingService.kt");
    const block = kotlinBlock(svc, "RINGTONE_RAW_NAMES");
    expect(sorted(kotlinIds(block))).toEqual(sorted(callIds));
    for (const m of block.matchAll(/"(\w+)"\s+to\s+"(\w+)"/g)) expect(m[2]).toBe(`${m[1]}_call`);
  });

  it("iOS: CallKit accepts every ringtone id", () => {
    const src = read("native/ios/CallKitManager.swift");
    const m = /VALID_RINGTONE_IDS: Set<String> = \[([\s\S]*?)\]/.exec(src);
    expect(m).toBeTruthy();
    expect(sorted(Array.from(m![1].matchAll(/"(\w+)"/g), (x) => x[1]))).toEqual(sorted(callIds));
  });

  it("every id has all three bundled asset formats", () => {
    const missing: string[] = [];
    const want = (rel: string) => { if (!existsSync(path.join(ROOT, rel))) missing.push(rel); };
    for (const id of msgIds) {
      want(`public/sounds/${id}_msg.m4a`); want(`native/android/res_raw/${id}_msg.ogg`); want(`native/ios/Sounds/${id}_msg.caf`);
    }
    for (const id of callIds) {
      want(`public/sounds/${id}_call.m4a`); want(`native/android/res_raw/${id}_call.ogg`); want(`native/ios/Sounds/${id}_call.caf`);
    }
    expect(missing).toEqual([]);
  });

  it("preview file paths point at the bundled web asset for the same id", () => {
    for (const o of MESSAGE_SOUNDS) expect(o.previewFile).toBe(`/sounds/${o.id}_msg.m4a`);
    for (const o of CALL_RINGTONES) expect(o.previewFile).toBe(`/sounds/${o.id}_call.m4a`);
  });

  it("no stray sound assets that no catalog entry references", () => {
    // alert_important / alert_urgent are the /important + /urgent message
    // alerts (not user-selectable) — see messageAlert.test.ts.
    const known = new Set([
      ...msgIds.map((i) => `${i}_msg`), ...callIds.map((i) => `${i}_call`),
      "alert_important", "alert_urgent",
    ]);
    for (const dir of ["public/sounds", "native/android/res_raw", "native/ios/Sounds"]) {
      for (const f of readdirSync(path.join(ROOT, dir))) {
        expect(known.has(f.replace(/\.[^.]+$/, "")), `${dir}/${f}`).toBe(true);
      }
    }
  });

  it("the latest sound-column migration accepts every id (shape check, not a stale list)", () => {
    const migs = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => /notification_sound/.test(f)).sort();
    const sql = read(`supabase/migrations/${migs[migs.length - 1]}`);
    const re = /CHECK \((?:message_sound|call_ringtone) ~ '([^']+)'\)/g;
    const patterns = Array.from(sql.matchAll(re), (m) => new RegExp(m[1]));
    expect(patterns.length).toBe(2);
    for (const id of [...msgIds, ...callIds]) for (const p of patterns) expect(p.test(id)).toBe(true);
  });
});
