/**
 * Consent gate for persisting a CAMERA-DERIVED mood reading to the server.
 *
 * A mood label inferred from a facial-expression scan is AI-derived data
 * (HIGHLY_SENSITIVE). The raw frames never leave the device (DEVICE_ONLY,
 * see sensorPolicy.ts), but the derived label used to be written to
 * Supabase's mood_logs unconditionally once the local toggle was on. It now
 * has to pass PrivacyGate: MOOD_PROCESSING consent granted, capability on,
 * destination SUPABASE legal for the class. Missing/unreadable consent =
 * denied, so nothing is saved.
 *
 * Person-selected moods are user-reported, not derived, and do NOT go
 * through this gate.
 */
import { canProcess, type PrivacyCheckResult } from "./privacyGate";
import { ConsentFeature } from "./consentFeatures";
import { DataClassification, ProcessingLocation } from "./dataClassification";

export function canPersistDerivedMood(userId: string): Promise<PrivacyCheckResult> {
  return canProcess({
    userId,
    feature: ConsentFeature.MOOD_PROCESSING,
    classification: DataClassification.HIGHLY_SENSITIVE,
    destination: ProcessingLocation.SUPABASE,
  });
}
