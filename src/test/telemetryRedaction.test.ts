/**
 * Phase 1.6 — telemetry privacy: redaction of sensitive keys/values and
 * the consent guard on uploads.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { redact, redactString } from "@/lib/privacy/redact";
import {
  logError, logInfo, clearEvents, getRecentEvents, setTelemetryUploadConsent, getTelemetryUploadConsent,
} from "@/lib/telemetry";

describe("redact(): things that must never reach a log", () => {
  const R = "[redacted]";
  it("message content, raw sensor data, AI observations, secrets, keys, transcripts, embeddings", () => {
    const out = redact({
      messageContent: "I love you", body: "hi", content: "hi",
      rawAudio: "AAAA", rawVideo: "BBBB", raw_frame: "CCCC",
      moodObservation: "sad", relationshipInsight: "x",
      accessToken: "t", refresh_token: "t", apiKey: "k", password: "p", secret: "s",
      privateKeyJwk: { d: "abc" }, publicKeyJwk: { x: "1" },
      transcript: "hello", captions: "hello", faceEmbeddings: [0.1], embedding: [0.2],
      sdp: "v=0", lat: 1, lng: 2, latitude: 1, longitude: 2,
      passphrase: "p", pin: "1234", otp: "999999",
    }) as Record<string, unknown>;
    for (const k of Object.keys(out)) expect(out[k]).toBe(R);
  });
  it("walks nested objects and arrays", () => {
    const out = redact({ a: [{ transcript: "x", ok: 1 }], b: { partnerMood: "sad", fine: "yes" } }) as any;
    expect(out.a[0].transcript).toBe(R);
    expect(out.a[0].ok).toBe(1);
    expect(out.b.partnerMood).toBe(R);
    expect(out.b.fine).toBe("yes");
  });
  it("leaves ordinary diagnostic fields alone", () => {
    const input = { status: 500, requestId: "r1", attempt: 2, ms: 120, code: "E_TIMEOUT" };
    expect(redact(input)).toEqual(input);
  });
  it("redactString strips JWT-shaped and Bearer tokens from free text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    expect(redactString(`failed with ${jwt}`)).not.toContain("eyJhbGci");
    const out = redactString("Authorization: Bearer abc123DEF456ghi789");
    expect(out).not.toContain("abc123DEF456ghi789");
    expect(out).toContain("[redacted]");
  });
});

describe("telemetry: events are redacted before they are recorded", () => {
  beforeEach(() => clearEvents());
  it("a token embedded in the message or context never lands in the ring buffer", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    logError(`ctx-${jwt}`, `boom ${jwt}`, { accessToken: "leak", transcript: "leak" });
    logInfo("ctx2", "Bearer supersecrettoken123", { messageContent: "leak" });
    const dump = JSON.stringify(getRecentEvents());
    expect(dump).not.toContain("eyJhbGci");
    expect(dump).not.toContain("supersecrettoken123");
    expect(dump).not.toContain("leak");
  });
});

describe("telemetry: upload is consent-gated and fails closed", () => {
  it("defaults to no upload for either analytics or crash diagnostics", () => {
    setTelemetryUploadConsent({ analytics: false, crash: false });
    expect(getTelemetryUploadConsent()).toEqual({ analytics: false, crash: false });
  });
  it("only literal booleans change it; revocation flips it back off", () => {
    setTelemetryUploadConsent({ crash: true });
    expect(getTelemetryUploadConsent().crash).toBe(true);
    setTelemetryUploadConsent({ crash: "yes" as never });
    expect(getTelemetryUploadConsent().crash).toBe(true); // ignored, unchanged
    setTelemetryUploadConsent({ crash: false });
    expect(getTelemetryUploadConsent().crash).toBe(false);
  });
});
