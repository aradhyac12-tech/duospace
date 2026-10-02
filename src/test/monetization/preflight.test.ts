import { describe, expect, it } from "vitest";
import { parseDotenv, runPreflight } from "../../../scripts/monetization-preflight.mjs";

const repo = {
  functionDirs: [
    "create-razorpay-order", "verify-razorpay-payment", "razorpay-webhook", "get-billing-account-token",
    "create-razorpay-subscription", "cancel-razorpay-subscription", "verify-google-play-purchase", "google-play-rtdn",
  ],
  configToml: "[functions.razorpay-webhook]\nverify_jwt = false\n\n[functions.google-play-rtdn]\nverify_jwt = false\n",
  migrations: ["20260926120000_monetization_entitlements_foundation.sql", "20260930120000_pause_pro_sales.sql"],
  admobXml: '<string name="duospace_admob_app_id" translatable="false">ca-app-pub-9602474807790470~4968934764</string>',
};
const goodSecrets = {
  RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "k", RAZORPAY_WEBHOOK_SECRET: "w",
  BILLING_ACCOUNT_HMAC_SECRET: "a".repeat(64),
};
const levels = (r: { level: string; id: string }[], id: string) => r.filter((x) => x.id === id).map((x) => x.level);
const fails = (r: { level: string }[]) => r.filter((x) => x.level === "FAIL");

describe("monetization preflight", () => {
  it("passes a clean staging setup", () => {
    const r = runPreflight({ target: "staging", clientEnv: { VITE_RAZORPAY_ENABLED: "true" }, secrets: goodSecrets, repo });
    expect(fails(r)).toEqual([]);
  });

  it("blocks live Razorpay keys on staging and test keys on production client builds", () => {
    expect(levels(runPreflight({ target: "staging", clientEnv: {}, secrets: { ...goodSecrets, RAZORPAY_KEY_ID: "rzp_live_x" }, repo }), "rzp-key-mode")).toEqual(["FAIL"]);
    expect(levels(runPreflight({ target: "production", clientEnv: { VITE_RAZORPAY_KEY_ID: "rzp_test_x" }, secrets: null, repo }), "client-rzp-key")).toEqual(["FAIL"]);
  });

  it("fails when a secret is exposed through a VITE_ variable", () => {
    const r = runPreflight({ target: "staging", clientEnv: { VITE_RAZORPAY_KEY_SECRET: "x" }, secrets: null, repo });
    expect(levels(r, "client-secret")).toEqual(["FAIL"]);
  });

  it("requires verify_jwt=false for both callback functions", () => {
    const r = runPreflight({ target: "staging", clientEnv: {}, secrets: null, repo: { ...repo, configToml: "[functions.razorpay-webhook]\nverify_jwt = false\n" } });
    expect(levels(r, "jwt-google-play-rtdn")).toEqual(["FAIL"]);
    expect(levels(r, "jwt-razorpay-webhook")).toEqual(["PASS"]);
  });

  it("rejects test ad units in production but only warns elsewhere", () => {
    const env = { VITE_ADS_ENABLED: "true", VITE_ADMOB_BANNER_UNIT_ID: "ca-app-pub-3940256099942544/9214589741" };
    expect(levels(runPreflight({ target: "production", clientEnv: env, secrets: null, repo }), "ads-unit")).toEqual(["FAIL"]);
    expect(levels(runPreflight({ target: "staging", clientEnv: env, secrets: null, repo }), "ads-unit")).toEqual(["WARN"]);
  });

  it("flags weak/reused server secrets and unparsable Play JSON", () => {
    const r = runPreflight({
      target: "staging", clientEnv: {},
      secrets: { ...goodSecrets, BILLING_ACCOUNT_HMAC_SECRET: "short", RAZORPAY_WEBHOOK_SECRET: "k", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "{oops" },
      repo,
    });
    expect(levels(r, "hmac-strength")).toEqual(["FAIL"]);
    expect(levels(r, "webhook-secret-reuse")).toEqual(["FAIL"]);
    expect(levels(r, "play-json")).toEqual(["FAIL"]);
  });

  it("requires Pub/Sub settings once Play is configured, and never echoes secret values", () => {
    const play = JSON.stringify({ client_email: "a@b.iam", private_key: "SUPERSECRETKEY" });
    const r = runPreflight({ target: "staging", clientEnv: {}, secrets: { ...goodSecrets, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: play }, repo });
    expect(levels(r, "secret-PUBSUB_PUSH_AUDIENCE")).toEqual(["FAIL"]);
    expect(JSON.stringify(r)).not.toContain("SUPERSECRETKEY");
  });

  it("parses dotenv with quotes, export and comments", () => {
    expect(parseDotenv('# c\nexport A="x y"\nB=\'z\'\nC=1\n')).toEqual({ A: "x y", B: "z", C: "1" });
  });
});
