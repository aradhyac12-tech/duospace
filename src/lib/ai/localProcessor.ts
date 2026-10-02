/**
 * LocalAIProcessor — the interface, not an actual model. See
 * .ai/LOCAL_AI_ARCHITECTURE.md.
 *
 *   LOCAL INPUT -> LOCAL PROCESSOR -> STRUCTURED RESULT -> VALIDATION -> ENCRYPTED LOCAL STORAGE
 *
 * A LocalAIProcessor implementation must not require network access — if
 * an implementation needs Supabase or any remote endpoint, it belongs
 * behind CloudAIProcessor (a distinct, explicitly-consent-gated
 * capability — CLOUD_AI_PROCESSING in consent.ts), never this one.
 *
 * No concrete processor exists yet (feature freeze — this phase builds
 * the interface future features implement, not the features themselves).
 */

import type { NewAIInsight } from "./types";
import { validateInsight, type ValidationResult } from "./outputValidator";
import { canProcess, type PrivacyCheckRequest, type PrivacyGateDeps } from "../privacy/privacyGate";
import { ProcessingLocation } from "../privacy/dataClassification";
import { checkAIProvenance, LOCAL_PROCESSOR_EXPECTATIONS } from "./provenance";

export interface LocalProcessorInput {
  userId: string;
  /** Arbitrary structured local data the processor needs — shape is processor-specific. */
  data: Record<string, unknown>;
}

export interface LocalProcessorResult {
  insight: NewAIInsight;
  validation: ValidationResult;
}

export interface LocalAIProcessor {
  /** Matches a ConsentFeature value — used for the privacy-gate check before run() is even called. */
  readonly feature: string;
  readonly modelVersion: string;
  run(input: LocalProcessorInput): Promise<LocalProcessorResult>;
}

/**
 * Runs a processor through the required pipeline: privacy gate first,
 * then the processor itself, then output validation. A processor's own
 * run() should NOT re-check consent internally — this wrapper is the one
 * required entrypoint, so consent/capability logic lives in exactly one
 * place (privacyGate.ts) rather than being re-implemented (and
 * potentially gotten subtly wrong) inside every processor.
 */
export async function runLocalProcessor(
  processor: LocalAIProcessor,
  input: LocalProcessorInput,
  gateContext: Omit<PrivacyCheckRequest, "userId" | "feature">,
  /** Phase 2A: injectable consent lookup, forwarded to canProcess() — exists so revocation is testable without a database. Production callers omit it. */
  gateDeps?: PrivacyGateDeps,
): Promise<LocalProcessorResult> {
  // A LOCAL processor runs on the device, full stop. A caller asking it to
  // "process" somewhere else is asking for a cloud path, which is a different,
  // separately consent-gated capability.
  if (gateContext.destination !== ProcessingLocation.DEVICE) {
    throw new Error(`Cannot run ${processor.feature}: a local processor may only run with destination DEVICE (got ${gateContext.destination}).`);
  }
  const gate = await canProcess({
    userId: input.userId,
    feature: processor.feature as PrivacyCheckRequest["feature"],
    ...gateContext,
  }, gateDeps);
  if (!gate.allowed) {
    throw new Error(`Cannot run ${processor.feature}: ${gate.reason}`);
  }

  const result = await processor.run(input);
  const validation = validateInsight(result.insight);
  if (!validation.valid) {
    // A processor producing an invalid insight is a bug in the processor,
    // not a user-facing error — surface it loudly rather than silently
    // storing something that failed its own safety contract.
    throw new Error(
      `Processor ${processor.feature} (v${processor.modelVersion}) produced an insight that failed validation: ${validation.issues
        .map((i) => `[${i.field}] ${i.message}`)
        .join("; ")}`,
    );
  }
  // Provenance: whatever the processor returned, it must be labelled as
  // AI-derived, produced on-device, HIGHLY_SENSITIVE and for this feature —
  // never as something the user said.
  const provenance = checkAIProvenance(result.insight, LOCAL_PROCESSOR_EXPECTATIONS(processor.feature));
  if (provenance.length > 0) {
    throw new Error(
      `Processor ${processor.feature} (v${processor.modelVersion}) produced an insight that failed provenance checks: ${provenance
        .map((i) => `[${i.field}] ${i.message}`)
        .join("; ")}`,
    );
  }
  return { insight: result.insight, validation };
}
