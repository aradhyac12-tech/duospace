// Deno-native tests (this dir is excluded from vitest — see
// vitest.config.ts's `exclude: ["**/supabase/functions/**"]`, since these
// run under the Supabase Edge Runtime's Deno, not Node/jsdom).
//
// STATIC VERIFICATION ONLY: not run in this sandbox (no `deno` binary
// available here — see AGENTS.md/BUILD.md for the general "no network/CLI
// tooling" constraint). Written to the standard Deno.test/assert API so
// `deno test supabase/functions/_shared` on a machine with the Supabase
// CLI runs them as-is. Do not read a passing run into this repo's history
// until someone has actually executed it.
import { assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildVoipPayload } from "../apns.ts";

Deno.test("buildVoipPayload: carries only the fields PushKit needs to identify the call", () => {
  const payload = buildVoipPayload({
    event: "incoming",
    callId: "11111111-1111-1111-1111-111111111111",
    callerId: "22222222-2222-2222-2222-222222222222",
    callerName: "Sam",
    callType: "video",
    timestamp: "2026-08-08T00:00:00.000Z",
  });

  assertEquals(payload.event, "incoming");
  assertEquals(payload.callId, "11111111-1111-1111-1111-111111111111");
  assertEquals(payload.callerName, "Sam");
  assertEquals(payload.callType, "video");

  // SECURITY (item 7): must never carry a Daily access token, a Supabase
  // JWT, or any other long-lived/private credential — the native layer
  // fetches those separately, authenticated, after the call is answered.
  const serialized = JSON.stringify(payload);
  assertFalse(serialized.toLowerCase().includes("token"));
  assertFalse(serialized.toLowerCase().includes("jwt"));
  assertFalse(serialized.toLowerCase().includes("secret"));
});

Deno.test("buildVoipPayload: aps block carries no alert/sound/badge (VoIP pushes are silent by design)", () => {
  const payload = buildVoipPayload({
    event: "cancel",
    callId: "11111111-1111-1111-1111-111111111111",
    callerId: "22222222-2222-2222-2222-222222222222",
    callerName: "Sam",
    callType: "audio",
    timestamp: "2026-08-08T00:00:00.000Z",
  });

  const aps = payload.aps as Record<string, unknown>;
  assertEquals(Object.keys(aps).length, 0);
});

Deno.test("buildVoipPayload: stays well under Apple's ~5KB VoIP payload limit", () => {
  const payload = buildVoipPayload({
    event: "incoming",
    callId: "11111111-1111-1111-1111-111111111111",
    callerId: "22222222-2222-2222-2222-222222222222",
    // A deliberately long display name (couples apps let users set custom
    // pet names) shouldn't be able to blow the payload budget.
    callerName: "A".repeat(200),
    callType: "video",
    timestamp: "2026-08-08T00:00:00.000Z",
  });
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  // 5120 is the hard cap enforced in apns.ts (MAX_PAYLOAD_BYTES); this
  // payload shape should never come close even with a very long name.
  assertEquals(bytes < 1024, true);
});
