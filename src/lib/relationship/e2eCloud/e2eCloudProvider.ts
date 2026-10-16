/**
 * E2E_CLOUD provider — BLOCKED.
 *
 * Genuine end-to-end-encrypted inference needs the model to run where only
 * the user can decrypt: an attested TEE (e.g. confidential VMs/GPUs) whose
 * enclave key the client verifies via remote attestation before sealing the
 * request (envelope.ts). DuoSpace has no such endpoint, no attestation
 * verifier, and no consent flow for cloud AI. A normal server or third-party
 * AI API would see plaintext, which is NOT E2E — so this provider is never
 * available, performs NO network requests, and the router cannot select it.
 */
import { ProcessingLocation } from "../../privacy/dataClassification";
import { RelationshipError } from "../errors";
import type { RelationshipAIProvider } from "../provider";
import type { CloudStatus } from "../executionMode";

export const E2E_CLOUD_STATUS: CloudStatus = Object.freeze({
  available: false,
  userConsented: false,
  reason: "E2E cloud AI is blocked: no attested confidential-computing inference endpoint exists",
});

const refuse = async (): Promise<never> => { throw new RelationshipError("E2E_CLOUD_UNAVAILABLE"); };

export const e2eCloudProvider: RelationshipAIProvider = {
  info: {
    id: "e2e-cloud-v0",
    kind: "CLOUD_MODEL",
    processingLocation: ProcessingLocation.CLOUD_AI,
    modelVersion: "none",
    isProduction: false,
    description: "BLOCKED — no attested TEE inference endpoint; never sends data.",
  },
  analyzeValues: refuse,
  analyzeExpectations: refuse,
  analyzeCommunicationReflection: refuse,
};
