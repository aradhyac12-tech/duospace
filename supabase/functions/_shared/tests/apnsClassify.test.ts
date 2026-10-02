// STATIC VERIFICATION ONLY — see apns.test.ts's header comment for why
// these are not (and cannot be) executed in this sandbox.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyApnsFailure } from "../apns.ts";

Deno.test("classifyApnsFailure: BadDeviceToken/DeviceTokenNotForTopic/Unregistered are permanent", () => {
  for (const reason of ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]) {
    const result = classifyApnsFailure(400, { reason });
    assertEquals(result.permanent, true, `${reason} should be permanent`);
    assertEquals(result.retryable, false, `${reason} should not be retryable`);
  }
});

Deno.test("classifyApnsFailure: ExpiredProviderToken/InvalidProviderToken are retryable, not permanent", () => {
  for (const reason of ["ExpiredProviderToken", "InvalidProviderToken"]) {
    const result = classifyApnsFailure(403, { reason });
    assertEquals(result.permanent, false, `${reason} should not deactivate the device token`);
    assertEquals(result.retryable, true, `${reason} should retry (a fresh JWT may fix it)`);
  }
});

Deno.test("classifyApnsFailure: BadTopic/PayloadTooLarge are neither retryable nor permanent (config bug)", () => {
  for (const reason of ["BadTopic", "PayloadTooLarge"]) {
    const result = classifyApnsFailure(400, { reason });
    assertEquals(result.permanent, false);
    assertEquals(result.retryable, false);
  }
});

Deno.test("classifyApnsFailure: TooManyRequests/InternalServerError/Shutdown are retryable transient failures", () => {
  for (const reason of ["TooManyRequests", "InternalServerError", "Shutdown"]) {
    const result = classifyApnsFailure(500, { reason });
    assertEquals(result.retryable, true);
    assertEquals(result.permanent, false);
  }
});

Deno.test("classifyApnsFailure: unknown reason is neither retryable nor permanent (doesn't loop, doesn't nuke the token)", () => {
  const result = classifyApnsFailure(418, { reason: "SomethingNewAppleAdded" });
  assertEquals(result.retryable, false);
  assertEquals(result.permanent, false);
  assertEquals(result.reason, "SomethingNewAppleAdded");
});
