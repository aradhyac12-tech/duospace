/**
 * Tests for the log/telemetry redaction utility (src/lib/privacy/redact.ts).
 * Phase 1 privacy/AI foundation — see .ai/PRIVACY_MODEL.md.
 */
import { describe, it, expect } from "vitest";
import { redact, redactString } from "@/lib/privacy/redact";

describe("redact: key-based redaction", () => {
  it("redacts a top-level accessToken field", () => {
    const out = redact({ accessToken: "super-secret-value", ok: true }) as Record<string, unknown>;
    expect(out.accessToken).toBe("[redacted]");
    expect(out.ok).toBe(true);
  });

  it("redacts common secret-shaped key names case-insensitively", () => {
    const input = {
      Password: "hunter2",
      API_KEY: "abc123",
      refreshToken: "xyz",
      private_key: "pem-data",
      Authorization: "Bearer abc",
    };
    const out = redact(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(out[key]).toBe("[redacted]");
    }
  });

  it("redacts nested secret fields", () => {
    const out = redact({ user: { id: "u1", session: { accessToken: "secret" } } }) as any;
    expect(out.user.id).toBe("u1");
    expect(out.user.session.accessToken).toBe("[redacted]");
  });

  it("redacts secret fields inside arrays of objects", () => {
    const out = redact([{ token: "a" }, { token: "b" }]) as any[];
    expect(out[0].token).toBe("[redacted]");
    expect(out[1].token).toBe("[redacted]");
  });

  it("leaves non-sensitive fields untouched", () => {
    const input = { userId: "u1", feature: "MOOD_PROCESSING", count: 3 };
    expect(redact(input)).toEqual(input);
  });

  it("does not throw on circular references", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    expect(() => redact(obj)).not.toThrow();
  });

  it("passes through null and undefined", () => {
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });
});

describe("redact: JWT-shaped string values", () => {
  it("redacts a bare string that looks like a JWT even under a harmless key name", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redact({ note: jwt }) as Record<string, unknown>;
    expect(out.note).toBe("[redacted]");
  });

  it("leaves an ordinary string alone", () => {
    const out = redact({ note: "just a normal sentence" }) as Record<string, unknown>;
    expect(out.note).toBe("just a normal sentence");
  });
});

describe("redactString", () => {
  it("redacts a JWT-shaped substring embedded in a longer message", () => {
    const msg = "request failed with token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U attached";
    const out = redactString(msg);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("[redacted]");
  });

  it("leaves a message with no token-shaped substring unchanged", () => {
    const msg = "network request timed out after 5000ms";
    expect(redactString(msg)).toBe(msg);
  });
});
