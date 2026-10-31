/**
 * Provider registry.
 *
 *   RelationshipAIProvider
 *     ├── local-rule-v1   deterministic, on-device — DEFAULT and guaranteed fallback
 *     ├── local-model-v1  on-device model — opt-in build flag + verified model only
 *     └── cloud-model-v1  NOT IMPLEMENTED (no cloud AI in this phase; the
 *                         pipeline refuses any non-DEVICE provider)
 */
import type { RelationshipAIProvider } from "./provider";
import { localRuleProvider } from "./providers/localRuleProvider";
import { createLocalModelProvider } from "./providers/localModelProvider";

export const localModelProvider = createLocalModelProvider();

export const PROVIDER_REGISTRY: Readonly<Record<string, RelationshipAIProvider>> = {
  [localRuleProvider.info.id]: localRuleProvider,
  [localModelProvider.info.id]: localModelProvider,
};

export const DEFAULT_PROVIDER_ID = localRuleProvider.info.id;

export function getDefaultProvider(): RelationshipAIProvider {
  return localRuleProvider;
}

/** The provider to try first plus its deterministic fallback. The local
 *  model is chosen only when this build enabled it AND the device reports a
 *  verified, available model; otherwise local-rule-v1 runs directly. */
export function selectProviders(): { primary: RelationshipAIProvider; fallback: RelationshipAIProvider; usesLocalModel: boolean } {
  if (localModelProvider.isAvailable()) {
    return { primary: localModelProvider, fallback: localRuleProvider, usesLocalModel: true };
  }
  return { primary: localRuleProvider, fallback: localRuleProvider, usesLocalModel: false };
}
