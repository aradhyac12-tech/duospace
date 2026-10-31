/**
 * Central consent model for DuoSpace. See .ai/CONSENT_MODEL.md.
 *
 * Consent is feature-specific, explicit, revocable, and granular — never
 * one global "I agree" toggle. Consent state lives server-side
 * (Supabase `user_consents`, RLS'd to the owning user only — see
 * supabase/migrations/20260917100000_privacy_consent_foundation.sql) so
 * it's consistent across a person's devices, the same way their other
 * account state already is. Revoking consent has an immediate,
 * enforced consequence — see privacyGate.ts, which checks this service
 * before any sensitive processing runs.
 */

import { supabase } from "@/integrations/supabase/appClient";
import { logError, setTelemetryUploadConsent } from "@/lib/telemetry";

// The vocabulary lives in ./consentFeatures (dependency-free, so the pure
// policy code and tests can use it without the Supabase client) and is
// re-exported here unchanged for every existing importer.
import { ConsentFeature, CONSENT_SCHEMA_VERSION, isConsentActive } from "./consentFeatures";
export { ConsentFeature, CONSENT_SCHEMA_VERSION };

export interface ConsentRecord {
  id: string;
  userId: string;
  feature: ConsentFeature;
  granted: boolean;
  version: number;
  source: string; // e.g. "settings_screen", "onboarding"
  grantedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

type ConsentRow = {
  id: string;
  user_id: string;
  feature: string;
  granted: boolean;
  version: number;
  source: string;
  granted_at: string | null;
  revoked_at: string | null;
  updated_at: string;
};

function rowToRecord(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    feature: row.feature as ConsentFeature,
    granted: row.granted,
    version: row.version,
    source: row.source,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    updatedAt: row.updated_at,
  };
}

/** In-memory cache so PrivacyGate.canProcess() (called on every sensitive
 * op) doesn't round-trip to Supabase each time. Invalidated on grant/revoke
 * and on sign-out (see App.tsx's auth-state listener, which should call
 * clearConsentCache() — see .ai/CONSENT_MODEL.md for the integration note
 * if that wiring isn't in yet). Stale-for-up-to-CACHE_TTL_MS is an
 * accepted trade-off for revocation latency vs. not hitting the network
 * on every gated call; CACHE_TTL_MS is short specifically so a revoke
 * takes effect quickly even if the invalidation call is ever missed.
 */
const CACHE_TTL_MS = 30_000;
let cache: { userId: string; records: Map<ConsentFeature, ConsentRecord>; fetchedAt: number } | null = null;

export function clearConsentCache(): void {
  cache = null;
  // Signed out / consent changed: stop trusting any earlier "uploads are OK".
  // The next successful loadConsents() re-derives it from the server.
  setTelemetryUploadConsent({ analytics: false, crash: false });
}

async function loadConsents(userId: string): Promise<Map<ConsentFeature, ConsentRecord>> {
  if (cache && cache.userId === userId && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.records;
  }
  const { data, error } = await supabase
    .from("user_consents")
    .select("*")
    .eq("user_id", userId);
  if (error) {
    logError("consent", "failed to load consent records", error);
    // Fail closed: if we can't confirm consent, treat as not granted.
    return new Map();
  }
  const records = new Map<ConsentFeature, ConsentRecord>();
  for (const row of (data ?? []) as ConsentRow[]) {
    records.set(row.feature as ConsentFeature, rowToRecord(row));
  }
  cache = { userId, records, fetchedAt: Date.now() };
  setTelemetryUploadConsent({
    analytics: isConsentActive(records.get(ConsentFeature.ANALYTICS)),
    crash: isConsentActive(records.get(ConsentFeature.CRASH_DIAGNOSTICS)),
  });
  return records;
}

/** True only if the feature has an explicit, current-version, granted (not revoked) record. Missing = not granted. Fails closed on any error. */
export async function hasConsent(userId: string, feature: ConsentFeature): Promise<boolean> {
  if (!userId) return false;
  const records = await loadConsents(userId);
  return isConsentActive(records.get(feature));
}

export async function getAllConsents(userId: string): Promise<ConsentRecord[]> {
  const records = await loadConsents(userId);
  return Array.from(records.values());
}

export async function grantConsent(userId: string, feature: ConsentFeature, source: string): Promise<void> {
  const { error } = await supabase.from("user_consents").upsert(
    {
      user_id: userId,
      feature,
      granted: true,
      version: CONSENT_SCHEMA_VERSION,
      source,
      granted_at: new Date().toISOString(),
      revoked_at: null,
    },
    { onConflict: "user_id,feature" },
  );
  if (error) {
    logError("consent", `failed to grant consent for ${feature}`, error);
    throw error;
  }
  clearConsentCache();
}

export async function revokeConsent(userId: string, feature: ConsentFeature): Promise<void> {
  const { error } = await supabase.from("user_consents").upsert(
    {
      user_id: userId,
      feature,
      granted: false,
      version: CONSENT_SCHEMA_VERSION,
      source: "revocation",
      revoked_at: new Date().toISOString(),
    },
    { onConflict: "user_id,feature" },
  );
  if (error) {
    logError("consent", `failed to revoke consent for ${feature}`, error);
    throw error;
  }
  clearConsentCache();
  // Revocation must stop *future* processing immediately (the cache clear
  // above handles that for anything gated through PrivacyGate). It does
  // NOT retroactively delete already-derived insights — that is a
  // separate, explicit action (see ../ai/deleteInsight in a future pass);
  // conflating "stop processing" with "delete history" would surprise a
  // user who revoked consent for one reason but expected to keep reading
  // insights they already have.
}

/**
 * KI-05: export a person's own consent records and AI-derived insights as a
 * plain JSON document. Only rows they own (user_id = userId) are included —
 * insights a partner shared WITH them belong to the partner's export, not
 * this one. Reads bypass the consent cache on purpose: an export should
 * reflect the server's current state, not a 30 s-old copy. Throws on any
 * query error rather than returning a partial file that looks complete.
 */
export async function exportPrivacyData(userId: string): Promise<string> {
  if (!userId) throw new Error("exportPrivacyData: missing userId");
  const [consents, insights] = await Promise.all([
    supabase.from("user_consents").select("*").eq("user_id", userId),
    supabase.from("ai_insights").select("*").eq("user_id", userId),
  ]);
  if (consents.error) {
    logError("consent", "export: failed to load consent records", consents.error);
    throw consents.error;
  }
  if (insights.error) {
    logError("consent", "export: failed to load insights", insights.error);
    throw insights.error;
  }
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      schemaVersion: CONSENT_SCHEMA_VERSION,
      consents: consents.data ?? [],
      insights: insights.data ?? [],
    },
    null,
    2,
  );
}
