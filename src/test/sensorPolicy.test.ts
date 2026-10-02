/**
 * Phase 1.6 — camera/microphone capability enforcement.
 * Pure policy (sensorPolicy.ts) + the settings parser + a static inventory
 * scan that fails if a source file uses the camera/microphone without being
 * registered.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  SENSOR_PURPOSES, BUS_CAMERA_PURPOSES, SENSOR_INFRASTRUCTURE_FILES, NO_SENSOR_SETTINGS,
  evaluateSensorRequest, parseSensorSettings, type SensorSettings,
} from "@/lib/privacy/sensorPolicy";
import { DataClassification } from "@/lib/privacy/dataClassification";

const on = (o: Partial<SensorSettings>): SensorSettings => ({ ...NO_SENSOR_SETTINGS, ...o });

describe("sensor policy: automatic purposes require their opt-in", () => {
  it("PEEK_GUARD needs peekGuard", () => {
    expect(evaluateSensorRequest("PEEK_GUARD", NO_SENSOR_SETTINGS).allowed).toBe(false);
    expect(evaluateSensorRequest("PEEK_GUARD", on({ peekGuard: true })).allowed).toBe(true);
  });
  it("MOOD_DETECTION needs moodDetection", () => {
    expect(evaluateSensorRequest("MOOD_DETECTION", NO_SENSOR_SETTINGS).allowed).toBe(false);
    expect(evaluateSensorRequest("MOOD_DETECTION", on({ moodDetection: true })).allowed).toBe(true);
  });
  it("MOOD_BACKGROUND needs BOTH moodDetection and moodBackgroundDetection", () => {
    expect(evaluateSensorRequest("MOOD_BACKGROUND", on({ moodDetection: true })).allowed).toBe(false);
    expect(evaluateSensorRequest("MOOD_BACKGROUND", on({ moodBackgroundDetection: true })).allowed).toBe(false);
    expect(evaluateSensorRequest("MOOD_BACKGROUND", on({ moodDetection: true, moodBackgroundDetection: true })).allowed).toBe(true);
  });
  it("turning a toggle off (revocation) denies the very next request", () => {
    const enabled = on({ peekGuard: true });
    expect(evaluateSensorRequest("PEEK_GUARD", enabled).allowed).toBe(true);
    expect(evaluateSensorRequest("PEEK_GUARD", { ...enabled, peekGuard: false }).allowed).toBe(false);
  });
  it("one purpose's opt-in does not authorise another", () => {
    expect(evaluateSensorRequest("MOOD_DETECTION", on({ peekGuard: true })).allowed).toBe(false);
    expect(evaluateSensorRequest("PEEK_GUARD", on({ moodDetection: true })).allowed).toBe(false);
  });
});

describe("sensor policy: user-action purposes must be user-initiated", () => {
  it("are denied unless the call site says the user started them", () => {
    for (const id of ["FACE_ENROLLMENT", "PHOTO_CAPTURE"]) {
      expect(evaluateSensorRequest(id, NO_SENSOR_SETTINGS).allowed).toBe(false);
      expect(evaluateSensorRequest(id, NO_SENSOR_SETTINGS, { userInitiated: false }).allowed).toBe(false);
      expect(evaluateSensorRequest(id, NO_SENSOR_SETTINGS, { userInitiated: true }).allowed).toBe(true);
    }
  });
});

describe("sensor policy: fails closed", () => {
  it("unknown purpose", () => {
    expect(evaluateSensorRequest("SPY_ON_PARTNER", on({ peekGuard: true, moodDetection: true }), { userInitiated: true }).allowed).toBe(false);
    expect(evaluateSensorRequest("__proto__", null, { userInitiated: true }).allowed).toBe(false);
    expect(evaluateSensorRequest("toString", null, { userInitiated: true }).allowed).toBe(false);
  });
  it("missing settings snapshot", () => {
    expect(evaluateSensorRequest("PEEK_GUARD", null).allowed).toBe(false);
    expect(evaluateSensorRequest("MOOD_BACKGROUND", undefined).allowed).toBe(false);
  });
});

describe("parseSensorSettings", () => {
  it("returns all-off for missing / malformed input", () => {
    for (const raw of [null, undefined, "", "not json", "null", "42", "[]"]) {
      expect(parseSensorSettings(raw as never)).toEqual(NO_SENSOR_SETTINGS);
    }
  });
  it("only a literal boolean true counts (not 'true', 1, or truthy strings)", () => {
    const s = parseSensorSettings(JSON.stringify({ peekGuard: "true", moodDetection: 1, moodBackgroundDetection: "yes" }));
    expect(s).toEqual(NO_SENSOR_SETTINGS);
  });
  it("a stale background flag under a disabled parent is ignored (the persisted-state bug)", () => {
    const s = parseSensorSettings(JSON.stringify({ moodDetection: false, moodBackgroundDetection: true }));
    expect(s.moodBackgroundDetection).toBe(false);
    expect(evaluateSensorRequest("MOOD_BACKGROUND", s).allowed).toBe(false);
  });
});

describe("sensor registry", () => {
  it("every purpose declares its raw data and that logs never receive it", () => {
    for (const spec of Object.values(SENSOR_PURPOSES)) {
      expect(spec.logsRawData).toBe(false);
      expect(spec.files.length).toBeGreaterThan(0);
      expect(spec.derived.length).toBeGreaterThan(10);
    }
  });
  it("camera-analysis purposes classify their raw signal DEVICE_ONLY", () => {
    for (const id of ["PEEK_GUARD", "MOOD_DETECTION", "MOOD_BACKGROUND", "FACE_ENROLLMENT", "LIP_READING"]) {
      expect(SENSOR_PURPOSES[id].rawClassification).toBe(DataClassification.DEVICE_ONLY);
    }
  });
  it("every bus purpose is registered", () => {
    for (const id of BUS_CAMERA_PURPOSES) expect(SENSOR_PURPOSES[id]).toBeDefined();
  });
  it("the unattended purpose is the only one with no visible UI", () => {
    const unattended = Object.values(SENSOR_PURPOSES).filter((s) => s.activation === "OPT_IN_SETTING_UNATTENDED").map((s) => s.id);
    expect(unattended).toEqual(["MOOD_BACKGROUND"]);
  });
  it("no purpose forwards a derived value to the partner without also being server-bound", () => {
    for (const s of Object.values(SENSOR_PURPOSES)) {
      if (s.derivedReachesPartner) expect(s.derivedReachesServer).toBe(true);
    }
  });
});

// ── static inventory: nobody uses the camera/mic outside the registry ─────────
const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name === "test" || name === "node_modules") continue; walk(p, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const codeOnly = (src: string) =>
  src.split("\n").filter((l) => { const t = l.trim(); return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")); }).join("\n");
const MEDIA_CALLS = /(getUserMedia\s*\(|acquireCamera\s*\(|new MediaRecorder\s*\(|\.setLocalVideo\s*\(|\.setLocalAudio\s*\(|setCameraEnabled\s*\(|setMicrophoneEnabled\s*\(|new Html5Qrcode\s*\()/;

describe("sensor inventory (static scan of src/)", () => {
  const registered = new Set<string>([
    ...SENSOR_INFRASTRUCTURE_FILES,
    ...Object.values(SENSOR_PURPOSES).flatMap((s) => [...s.files]),
  ]);
  const files = walk(join(ROOT, "src"));
  it("finds source files to scan", () => expect(files.length).toBeGreaterThan(50));
  it("every file that opens the camera/microphone is registered in the sensor policy", () => {
    const offenders = files
      .map((f) => relative(ROOT, f).split(sep).join("/"))
      .filter((rel) => MEDIA_CALLS.test(codeOnly(readFileSync(join(ROOT, rel), "utf8"))))
      .filter((rel) => !registered.has(rel));
    expect(offenders).toEqual([]);
  });
  it("every registered file actually exists (no stale registry entries)", () => {
    const missing = [...registered].filter((rel) => { try { statSync(join(ROOT, rel)); return false; } catch { return true; } });
    expect(missing).toEqual([]);
  });
  it("every acquireCamera() call outside cameraBus passes a purpose", () => {
    const bad: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split(sep).join("/");
      if (rel === "src/lib/cameraBus.ts") continue;
      for (const m of codeOnly(readFileSync(f, "utf8")).matchAll(/acquireCamera\s*\(([^)]*)\)/g)) {
        if (!/["'](PEEK_GUARD|MOOD_DETECTION|MOOD_BACKGROUND|FACE_ENROLLMENT|PHOTO_CAPTURE)["']/.test(m[1])) bad.push(`${rel}: acquireCamera(${m[1]})`);
      }
    }
    expect(bad).toEqual([]);
  });
});
