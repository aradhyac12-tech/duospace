/**
 * Central data-sensitivity classification for DuoSpace.
 *
 * Every piece of data any future AI/relationship-insight feature touches
 * must carry one of these labels. This is the vocabulary the Privacy Gate
 * (privacyGate.ts), the Consent model (consent.ts), and the AI insight
 * contract (../ai/types.ts) all key off of — it is intentionally the
 * single source of truth for "how sensitive is this" so those three
 * systems can't drift out of sync with each other.
 *
 * See .ai/DATA_CLASSIFICATION.md for the full reasoning and worked
 * examples per table/feature.
 */

export const DataClassification = {
  /** No sensitivity. App version, public feature flags, non-user config. */
  PUBLIC: "PUBLIC",
  /** Belongs to one person; not inherently relationship data. Normal profile fields. */
  PRIVATE: "PRIVATE",
  /** Mutually shared relationship information both partners already see (e.g. shared memories, shared playlists). */
  COUPLE: "COUPLE",
  /** Self-reported reflection data: mood check-ins, compatibility/values answers, relationship reflections. */
  SENSITIVE: "SENSITIVE",
  /** AI-derived interpretations of relationship/emotional state; intimate assessments; conflict analysis. */
  HIGHLY_SENSITIVE: "HIGHLY_SENSITIVE",
  /** Authentication secrets, API keys, refresh tokens, cryptographic key material. Never logged, never analytics. */
  SECRET: "SECRET",
  /** Raw signal that must never leave the device in raw form: raw mic/camera/video, local model intermediates. */
  DEVICE_ONLY: "DEVICE_ONLY",
} as const;

export type DataClassification = (typeof DataClassification)[keyof typeof DataClassification];

/**
 * Where a piece of data (or a processing step) is allowed to live/run/go.
 *
 * DEVICE, SUPABASE and CLOUD_AI are processing/storage locations.
 * PARTNER, ANALYTICS and LOGS are *egress destinations* — places data can
 * leak to even when nothing is "processing" it. They are modelled here on
 * purpose (Phase 1.6): Phase 1 only named the first three, which meant
 * "raw audio -> logs", "SECRET -> analytics" and "private AI insight ->
 * partner" were not expressible, so the gate could not refuse them.
 */
export const ProcessingLocation = {
  DEVICE: "DEVICE",
  SUPABASE: "SUPABASE",
  CLOUD_AI: "CLOUD_AI",
  /** The other half of the couple: another person's screen/account. */
  PARTNER: "PARTNER",
  /** Any usage-analytics sink. */
  ANALYTICS: "ANALYTICS",
  /** Console, ring buffer, crash reports, any diagnostic log. */
  LOGS: "LOGS",
} as const;

export type ProcessingLocation = (typeof ProcessingLocation)[keyof typeof ProcessingLocation];

/**
 * What the policy matrix says about one (classification, destination) pair.
 *
 *  ALLOW          — permitted by classification alone (the gate still
 *                   requires the feature's own consent + capability).
 *  CONSENT        — permitted only with the destination's extra consent
 *                   (see DESTINATION_CONSENT in privacyGate.ts).
 *  EXPLICIT_SHARE — permitted only with the SHARED_INSIGHTS consent AND an
 *                   explicit per-item share action by the owner.
 *  DENY           — never, regardless of consent, capability or intent.
 */
export type PolicyVerdict = "ALLOW" | "CONSENT" | "EXPLICIT_SHARE" | "DENY";

const D = ProcessingLocation;

/**
 * THE policy matrix — the single source of truth for "may data of this
 * class go there". Every cell is explicit so a newly-added classification
 * or destination fails the completeness test (see
 * src/test/privacyPolicy.test.ts) instead of silently defaulting to allow.
 *
 * Reading guide, by row:
 *  PUBLIC            harmless everywhere.
 *  PRIVATE           yours alone: device + your own server row; cloud AI only
 *                    with consent; never partner/analytics/logs.
 *  COUPLE            already shared by design, so PARTNER is fine; still not
 *                    analytics/logs.
 *  SENSITIVE         self-reported reflection data: partner only via an
 *                    explicit share.
 *  HIGHLY_SENSITIVE  AI-derived interpretations: same as SENSITIVE, and the
 *                    gate additionally demands the feature's consent for
 *                    every non-device destination.
 *  SECRET            never leaves secure storage through the gate.
 *  DEVICE_ONLY       raw mic/camera/video and local-model intermediates:
 *                    on-device processing only, nothing else — including
 *                    logs, because "raw audio/video -> logs" is a leak.
 */
export const POLICY_MATRIX: Readonly<Record<DataClassification, Readonly<Record<ProcessingLocation, PolicyVerdict>>>> = {
  PUBLIC:           { [D.DEVICE]: "ALLOW", [D.SUPABASE]: "ALLOW", [D.CLOUD_AI]: "ALLOW",   [D.PARTNER]: "ALLOW",          [D.ANALYTICS]: "ALLOW", [D.LOGS]: "ALLOW" },
  PRIVATE:          { [D.DEVICE]: "ALLOW", [D.SUPABASE]: "ALLOW", [D.CLOUD_AI]: "CONSENT", [D.PARTNER]: "DENY",           [D.ANALYTICS]: "DENY",  [D.LOGS]: "DENY"  },
  COUPLE:           { [D.DEVICE]: "ALLOW", [D.SUPABASE]: "ALLOW", [D.CLOUD_AI]: "CONSENT", [D.PARTNER]: "ALLOW",          [D.ANALYTICS]: "DENY",  [D.LOGS]: "DENY"  },
  SENSITIVE:        { [D.DEVICE]: "ALLOW", [D.SUPABASE]: "ALLOW", [D.CLOUD_AI]: "CONSENT", [D.PARTNER]: "EXPLICIT_SHARE", [D.ANALYTICS]: "DENY",  [D.LOGS]: "DENY"  },
  HIGHLY_SENSITIVE: { [D.DEVICE]: "ALLOW", [D.SUPABASE]: "ALLOW", [D.CLOUD_AI]: "CONSENT", [D.PARTNER]: "EXPLICIT_SHARE", [D.ANALYTICS]: "DENY",  [D.LOGS]: "DENY"  },
  SECRET:           { [D.DEVICE]: "DENY",  [D.SUPABASE]: "DENY",  [D.CLOUD_AI]: "DENY",    [D.PARTNER]: "DENY",           [D.ANALYTICS]: "DENY",  [D.LOGS]: "DENY"  },
  DEVICE_ONLY:      { [D.DEVICE]: "ALLOW", [D.SUPABASE]: "DENY",  [D.CLOUD_AI]: "DENY",    [D.PARTNER]: "DENY",           [D.ANALYTICS]: "DENY",  [D.LOGS]: "DENY"  },
};

/**
 * Looks up one matrix cell. FAILS CLOSED: an unknown classification or
 * destination (a stale string from persisted data, a future enum value
 * cast in from elsewhere) is a DENY, never an implicit allow.
 */
export function policyVerdict(classification: DataClassification, destination: ProcessingLocation): PolicyVerdict {
  const row = (POLICY_MATRIX as Record<string, Record<string, PolicyVerdict> | undefined>)[classification];
  const verdict = row?.[destination];
  return verdict ?? "DENY";
}

const DENY_REASONS: Partial<Record<DataClassification, string>> = {
  DEVICE_ONLY: "Raw signal (mic/camera/video/local-model-intermediate) may only be processed on-device — never cloud, server, partner, analytics or logs, consent or no consent.",
  SECRET: "Secrets (tokens, keys) are never routed through gated processing, and never reach any destination.",
  PRIVATE: "Private data never goes to the partner, analytics or logs.",
  COUPLE: "Couple data may be shared with the partner but never goes to analytics or logs.",
  SENSITIVE: "Sensitive reflection data never goes to analytics or logs.",
  HIGHLY_SENSITIVE: "AI-derived/highly sensitive data never goes to analytics or logs.",
};

/**
 * The complete set of (classification, destination) pairs that must NEVER
 * be allowed, regardless of consent state — DERIVED from POLICY_MATRIX so
 * the two can never drift. Kept as an exported list because privacyGate
 * and existing tests read it.
 */
export const ABSOLUTE_DENY_RULES: ReadonlyArray<{
  classification: DataClassification;
  destination: ProcessingLocation;
  reason: string;
}> = (Object.keys(POLICY_MATRIX) as DataClassification[]).flatMap((classification) =>
  (Object.keys(POLICY_MATRIX[classification]) as ProcessingLocation[])
    .filter((destination) => POLICY_MATRIX[classification][destination] === "DENY")
    .map((destination) => ({
      classification,
      destination,
      reason: DENY_REASONS[classification] ?? "Denied by the data-classification policy matrix.",
    })),
);

/** Human-readable label for UI copy — never expose the enum key raw to a user. */
export function classificationLabel(c: DataClassification): string {
  switch (c) {
    case DataClassification.PUBLIC: return "Not sensitive";
    case DataClassification.PRIVATE: return "Private to you";
    case DataClassification.COUPLE: return "Shared with your partner";
    case DataClassification.SENSITIVE: return "Sensitive reflection data";
    case DataClassification.HIGHLY_SENSITIVE: return "Highly sensitive (AI-derived)";
    case DataClassification.SECRET: return "Security-critical";
    case DataClassification.DEVICE_ONLY: return "Stays on this device";
  }
}
