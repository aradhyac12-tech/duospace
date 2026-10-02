/**
 * /important + /urgent message alerts. The tier definitions live in several
 * places that cannot share an import (client, Deno edge function, Kotlin,
 * bundled assets, SQL) — a drift between them means a flagged message quietly
 * falls back to sounding like a normal one, which is exactly the bug this
 * feature exists to fix. So drift is a test failure.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ALERT_TIERS, messageAlertLevel } from "@/lib/messageAlert";
import * as edge from "../../supabase/functions/_shared/messageAlert";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const kotlinArray = (src: string, name: string): number[] => {
  const m = new RegExp(`${name}\\s*=\\s*longArrayOf\\(([^)]*)\\)`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1].split(",").map((n) => Number(n.trim()));
};
const content = () => ({ title: "Sam", body: "Sent you a message", data: { type: "chat_message" } as Record<string, string>, channelId: "duospace_messages_classic", priority: "normal" as const, isCallAlert: false });

describe("which pushes are alerts", () => {
  it("urgent beats important; only message-like types qualify", () => {
    expect(edge.resolveAlertLevel({ type: "chat_message", important: true })).toBe("important");
    expect(edge.resolveAlertLevel({ type: "chat_message", important: true, urgent: true })).toBe("urgent");
    expect(edge.resolveAlertLevel({ type: "reply", urgent: true })).toBe("urgent");
    expect(edge.resolveAlertLevel({ type: "chat_message" })).toBeNull();
    expect(edge.resolveAlertLevel({ type: "incoming_audio_call", important: true })).toBeNull();
    expect(edge.resolveAlertLevel({ type: "friend_request", urgent: true })).toBeNull();
  });

  it("client picks the same tier from a message row", () => {
    expect(messageAlertLevel({ important: true, urgent: true })).toBe("urgent");
    expect(messageAlertLevel({ important: true })).toBe("important");
    expect(messageAlertLevel({ important: false, urgent: false })).toBeNull();
    expect(messageAlertLevel({})).toBeNull();
  });
});

describe("push payload per tier", () => {
  it("important and urgent get different channels, titles and alertLevel", () => {
    const a = edge.applyMessageAlert(content(), "important", "Sam");
    const b = edge.applyMessageAlert(content(), "urgent", "Sam");
    expect(a.channelId).toBe("duospace_alert_important_v2");
    expect(b.channelId).toBe("duospace_alert_urgent_v2");
    expect(a.channelId).not.toBe(b.channelId);
    expect(a.title).not.toBe(b.title);
    expect(a.title).toContain("Sam");
    expect(b.title).toContain("URGENT");
    expect(a.data.alertLevel).toBe("important");
    expect(b.data.alertLevel).toBe("urgent");
    expect(a.data.important).toBe("true");
    expect(b.data.important).toBe("true");
    expect(a.data.urgent).toBeUndefined();
    expect(b.data.urgent).toBe("true");
    expect(a.priority).toBe("high");
    expect(b.data.title).toBe(b.title);
  });

  it("never carries message content — the body stays generic", () => {
    expect(edge.applyMessageAlert(content(), "urgent", "Sam").body).toBe("Sent you a message");
  });

  it("iOS: distinct sound per tier; time-sensitive by default, critical only when enabled", () => {
    expect(edge.iosAlertAps("important", false)).toMatchObject({ sound: "alert_important.caf", "interruption-level": "time-sensitive" });
    expect(edge.iosAlertAps("urgent", false)).toMatchObject({ sound: "alert_urgent.caf", "interruption-level": "time-sensitive" });
    const crit = edge.iosAlertAps("urgent", true);
    expect(crit["interruption-level"]).toBe("critical");
    expect(crit.sound).toEqual({ critical: 1, name: "alert_urgent.caf", volume: 1 });
  });
});

describe("client ↔ Kotlin ↔ assets stay in sync", () => {
  const svc = read("native/android/MessageAlertService.kt");
  const channels = read("native/android/NotificationChannels.kt");

  it("vibration patterns match the client's (Settings test/in-app == real alert)", () => {
    expect(kotlinArray(svc, "IMPORTANT_VIBRATION")).toEqual(ALERT_TIERS.important.pattern);
    expect(kotlinArray(svc, "URGENT_VIBRATION")).toEqual(ALERT_TIERS.urgent.pattern);
  });

  it("the tiers are genuinely different, and both are LONG (not a normal buzz)", () => {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(ALERT_TIERS.important.pattern).not.toEqual(ALERT_TIERS.urgent.pattern);
    expect(ALERT_TIERS.important.soundFile).not.toBe(ALERT_TIERS.urgent.soundFile);
    // Longest normal message vibration in the catalog is well under 1 s in total;
    // a single alert pulse alone is longer than that.
    for (const t of Object.values(ALERT_TIERS)) {
      expect(Math.max(...t.pattern)).toBeGreaterThanOrEqual(700);
      expect(sum(t.pattern)).toBeGreaterThanOrEqual(3000);
      expect(t.pattern[0]).toBe(0);
      expect(t.pattern.length % 2).toBe(1); // wait + (on, off)* — ends on an "off"… odd count keeps even indices "off"
    }
    expect(ALERT_TIERS.urgent.nativeMaxMs).toBeGreaterThan(ALERT_TIERS.important.nativeMaxMs);
  });

  it("Android: channel ids + raw asset names match the edge function", () => {
    expect(channels).toContain(`ALERT_IMPORTANT = "${edge.ALERT_CHANNELS.important}"`);
    expect(channels).toContain(`ALERT_URGENT = "${edge.ALERT_CHANNELS.urgent}"`);
    expect(svc).toContain(`"${edge.ALERT_SOUND_NAMES.important}"`);
    expect(svc).toContain(`"${edge.ALERT_SOUND_NAMES.urgent}"`);
    expect(svc).toContain(`LEVEL_IMPORTANT = "important"`);
    expect(svc).toContain(`LEVEL_URGENT = "urgent"`);
  });

  it("Android: alerts ring on the ALARM stream with alarm vibration attributes (silent/DND bypass)", () => {
    expect(svc).toMatch(/USAGE_ALARM/);
    expect(svc).toMatch(/v\.vibrate\(effect, alarmAttributes\(\)\)/);
    expect(svc).toMatch(/isNotificationPolicyAccessGranted/);
    expect(svc).toMatch(/INTERRUPTION_FILTER_ALL/);
  });

  it("Android: the FCM handler hands alert pushes to the service before building a plain notification", () => {
    const h = read("native/android/DuoSpaceMessagingService.kt");
    expect(h).toContain("MessageAlertService.start(this, data)");
    expect(h.indexOf("MessageAlertService.start")).toBeLessThan(h.indexOf("NotificationCompat.Builder(this, channelId)"));
  });

  it("Android: build script ships, registers and permits the service", () => {
    const script = read("scripts/patch-native-permissions.mjs");
    expect(script).toContain('"MessageAlertService.kt"');
    expect(script).toContain('android:name=".MessageAlertService"');
    expect(script).toContain('android:foregroundServiceType="mediaPlayback"');
    expect(script).toContain("android.permission.ACCESS_NOTIFICATION_POLICY");
  });

  it("every tier has all three bundled asset formats, and iOS files fit Apple's 30 s cap", () => {
    for (const tier of ["important", "urgent"]) {
      for (const rel of [`public/sounds/alert_${tier}.m4a`, `native/android/res_raw/alert_${tier}.ogg`, `native/ios/Sounds/alert_${tier}.caf`]) {
        expect(existsSync(path.join(ROOT, rel)), rel).toBe(true);
      }
      // 16-bit mono 44.1 kHz PCM: 30 s == 2 646 000 bytes (+ small CAF header).
      expect(statSync(path.join(ROOT, `native/ios/Sounds/alert_${tier}.caf`)).size).toBeLessThan(2_646_000);
    }
    expect(ALERT_TIERS.important.soundFile).toBe("/sounds/alert_important.m4a");
    expect(ALERT_TIERS.urgent.soundFile).toBe("/sounds/alert_urgent.m4a");
  });

  it("the bridge plugin exposes the four Android alert methods", () => {
    const defs = read("native-plugins/callkit-bridge/src/definitions.ts");
    const kt = read("native-plugins/callkit-bridge/android/src/main/java/com/duospace/callkitbridge/DuospaceCallKitBridgePlugin.kt");
    for (const m of ["stopMessageAlert", "previewMessageAlert", "getMessageAlertStatus", "openDndAccessSettings"]) {
      expect(defs).toContain(`${m}(`);
      expect(kt).toContain(`fun ${m}(`);
    }
  });
});

describe("database trigger", () => {
  it("the newest notify_push_on_message migration forwards important AND urgent, and never the ciphertext preview", () => {
    const dir = path.join(ROOT, "supabase/migrations");
    const latest = readdirSync(dir).filter((f) => f.endsWith(".sql"))
      .filter((f) => /CREATE OR REPLACE FUNCTION public\.notify_push_on_message/i.test(readFileSync(path.join(dir, f), "utf8")))
      .sort().pop()!;
    const sql = read(`supabase/migrations/${latest}`);
    const body = sql.slice(sql.search(/CREATE OR REPLACE FUNCTION public\.notify_push_on_message/i));
    expect(body).toMatch(/'important',\s*\(COALESCE\(NEW\.important, false\) OR COALESCE\(NEW\.urgent, false\)\)/);
    expect(body).toMatch(/'urgent',\s*COALESCE\(NEW\.urgent, false\)/);
    expect(body).not.toMatch(/'preview'\s*,/);
    expect(body).toMatch(/IF NEW\.silent THEN/);
  });
});
