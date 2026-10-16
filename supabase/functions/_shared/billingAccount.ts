// Shared between get-billing-account-token and verify-google-play-purchase
// so both compute the identical HMAC — see get-billing-account-token/index.ts
// for the full design rationale (PHASE 6 account binding).
const HMAC_SECRET = Deno.env.get("BILLING_ACCOUNT_HMAC_SECRET");

export async function computeObfuscatedAccountId(userId: string): Promise<string> {
  if (!HMAC_SECRET) {
    throw new Error("BILLING_ACCOUNT_HMAC_SECRET is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
