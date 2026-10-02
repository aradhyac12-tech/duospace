import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/integrations/supabase/appClient", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import {
  interpretClaimResponse, rememberQrClaim, readQrClaim, clearQrClaim, CLAIM_MAX_AGE_MS,
} from "@/lib/qrPartnerClaim";

describe("interpretClaimResponse", () => {
  it("links on success", () => {
    expect(interpretClaimResponse({ success: true, partner_id: "p1" }, null)).toEqual({ status: "linked", partnerId: "p1" });
  });
  it("keeps the claim on a transport error", () => {
    expect(interpretClaimResponse(null, { message: "network" }).status).toBe("retry");
  });
  it("keeps the claim when the session isn't ready yet", () => {
    expect(interpretClaimResponse({ error: "NOT_SIGNED_IN" }, null).status).toBe("retry");
  });
  it.each(["NOTHING_TO_LINK", "EXPIRED", "NO_PARTNER_SCANNED", "SELF", "ALREADY_CLAIMED", "ALREADY_LINKED", "PROFILE_MISSING", "INVALID_TOKEN"])(
    "discards the claim for %s",
    (code) => {
      const r = interpretClaimResponse({ error: code }, null);
      expect(r.status).toBe("failed");
    },
  );
  it("treats an unknown server answer as retryable, never as success", () => {
    expect(interpretClaimResponse({ error: "SOMETHING_NEW" }, null).status).toBe("retry");
    expect(interpretClaimResponse({}, null).status).toBe("retry");
  });
});

describe("remembered claim", () => {
  beforeEach(() => clearQrClaim());
  it("round-trips", () => {
    rememberQrClaim("tok-1234567890abcdef", 1000);
    expect(readQrClaim(1000)?.token).toBe("tok-1234567890abcdef");
  });
  it("expires after the server's window", () => {
    rememberQrClaim("tok-1234567890abcdef", 0);
    expect(readQrClaim(CLAIM_MAX_AGE_MS + 1)).toBeNull();
    expect(readQrClaim(1)).toBeNull(); // and it was purged, not just hidden
  });
});
