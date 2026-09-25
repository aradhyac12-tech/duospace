/**
 * Sensor (camera / microphone) capability policy — PURE, dependency-free.
 *
 * Phase 1.6. Every consumer of the camera or microphone in the app is
 * registered here with its purpose, activation model and data-handling
 * facts. Two things consume the registry:
 *
 *  1. Runtime: `evaluateSensorRequest()` — called by sensorGate.ts from
 *     cameraBus.acquireCamera(), the single choke point for camera
 *     PROCESSING. A purpose that isn't registered, or whose opt-in isn't
 *     currently on, is denied (fail closed).
 *  2. Static: src/test/sensorInventory.test.ts scans the source tree and
 *     fails if any file touches getUserMedia/acquireCamera without being
 *     listed in a registry entry's `files` — so a new camera consumer
 *     cannot ship outside this system by accident.
 *
 * The registry describes the code AS IT IS. Where a consumer does
 * something the target privacy model would not allow, `knownGaps` says so
 * plainly — see .ai/KNOWN_ISSUES.md and the Phase 1.6 report.
 */
import { DataClassification } from "./dataClassification";

export type SensorKind = "CAMERA" | "MICROPHONE";

/**
 * How a session of the sensor is started.
 *  USER_ACTION              — the user directly triggers each session (tap
 *                             record / capture / scan / start call).
 *  OPT_IN_SETTING           — automatic sessions, but only while a
 *                             persistent, user-set toggle is ON, and with
 *                             visible UI while active.
 *  OPT_IN_SETTING_UNATTENDED— as above but with NO visible UI while active.
 *                             The most sensitive activation model; requires
 *                             its own explicit toggle in addition to its
 *                             parent feature's toggle.
 */
export type SensorActivation = "USER_ACTION" | "OPT_IN_SETTING" | "OPT_IN_SETTING_UNATTENDED";

/** The persistent, local opt-in toggles (`duo-settings` in localStorage) the automatic purposes depend on. */
export interface SensorSettings {
  peekGuard: boolean;
  moodDetection: boolean;
  moodBackgroundDetection: boolean;
}

export const NO_SENSOR_SETTINGS: SensorSettings = Object.freeze({
  peekGuard: false,
  moodDetection: false,
  moodBackgroundDetection: false,
});

export interface SensorPurposeSpec {
  id: string;
  sensor: SensorKind | "CAMERA+MICROPHONE";
  /** Plain-language purpose, as it should be disclosed to a user. */
  purpose: string;
  activation: SensorActivation;
  /** Which settings must ALL be true for an automatic purpose to be allowed. */
  requiresSettings: ReadonlyArray<keyof SensorSettings>;
  /** Classification of the RAW signal the sensor produces. */
  rawClassification: DataClassification;
  /** Where the raw signal goes. */
  rawDestination: "DEVICE_MEMORY_ONLY" | "DEVICE_STORAGE_THUMBNAIL" | "PEER_VIA_CALL_PROVIDER" | "USER_SENT_MESSAGE" | "NOWHERE";
  /** What is derived from it and where that derived data ends up. */
  derived: string;
  /** Does a derived value reach the server / the partner? */
  derivedReachesServer: boolean;
  derivedReachesPartner: boolean;
  /** Is the raw signal or a derivative written to logs/analytics/telemetry? */
  logsRawData: false;
  /** Source files that legitimately touch the sensor for this purpose. Used by the static inventory test. */
  files: readonly string[];
  /** Honest statement of anything short of the target model. Empty = none known. */
  knownGaps: readonly string[];
}

export const SENSOR_PURPOSES: Readonly<Record<string, SensorPurposeSpec>> = Object.freeze({
  PEEK_GUARD: {
    id: "PEEK_GUARD",
    sensor: "CAMERA",
    purpose: "Lock the app when someone other than the enrolled owner looks at the screen.",
    activation: "OPT_IN_SETTING",
    requiresSettings: ["peekGuard"],
    rawClassification: DataClassification.DEVICE_ONLY,
    rawDestination: "DEVICE_STORAGE_THUMBNAIL",
    derived: "Face-similarity scores and breach events (local event log); a 240px JPEG breach snapshot kept locally (max 20).",
    derivedReachesServer: false,
    derivedReachesPartner: false,
    logsRawData: false,
    files: ["src/components/PeekGuard.tsx", "src/hooks/usePeekDetection.ts", "src/lib/peekSnapshot.ts"],
    knownGaps: [
      "Breach snapshots (a photo that may show a third party's face) are stored as plaintext data-URLs in IndexedDB (duo-assets/blobs), not encrypted with secureStorage.",
      "Peek event log is plaintext in localStorage.",
    ],
  },
  MOOD_DETECTION: {
    id: "MOOD_DETECTION",
    sensor: "CAMERA",
    purpose: "Once a day, read a mood label from a 5-second on-device facial-expression scan the user can see running.",
    activation: "OPT_IN_SETTING",
    requiresSettings: ["moodDetection"],
    rawClassification: DataClassification.DEVICE_ONLY,
    rawDestination: "DEVICE_MEMORY_ONLY",
    derived: "Mood label + confidence + coarse capture-quality numbers -> Supabase mood_logs (own row). Requires MOOD_PROCESSING consent since Phase 1.6. Published to the partner-visible profile only after the user confirms it.",
    derivedReachesServer: true,
    derivedReachesPartner: true,
    logsRawData: false,
    files: ["src/components/MoodDetector.tsx"],
    knownGaps: [
      "mood_logs RLS policy 'View own and partner mood logs' lets the partner SELECT camera-derived rows (no client UI reads them, but the server allows it). Tightening needs a migration — see KNOWN_ISSUES.",
    ],
  },
  MOOD_BACKGROUND: {
    id: "MOOD_BACKGROUND",
    sensor: "CAMERA",
    purpose: "Periodically (every 2h, max 6/day) take a short silent expression read to build a mood trend.",
    activation: "OPT_IN_SETTING_UNATTENDED",
    requiresSettings: ["moodDetection", "moodBackgroundDetection"],
    rawClassification: DataClassification.DEVICE_ONLY,
    rawDestination: "DEVICE_MEMORY_ONLY",
    derived: "Mood label + confidence -> Supabase mood_logs (own row), tagged features.source='background'. Requires MOOD_PROCESSING consent. Never written to the partner-visible profile.",
    derivedReachesServer: true,
    derivedReachesPartner: true,
    logsRawData: false,
    files: ["src/hooks/useBackgroundMoodDetection.ts"],
    knownGaps: [
      "Runs with no visible UI (only the OS camera indicator); same partner-readable mood_logs RLS gap as MOOD_DETECTION.",
    ],
  },
  FACE_ENROLLMENT: {
    id: "FACE_ENROLLMENT",
    sensor: "CAMERA",
    purpose: "Enroll the owner's face template so Peek Guard can tell the owner from a stranger.",
    activation: "USER_ACTION",
    requiresSettings: [],
    rawClassification: DataClassification.DEVICE_ONLY,
    rawDestination: "DEVICE_MEMORY_ONLY",
    derived: "Face embedding template (biometric) stored locally in IndexedDB; never uploaded.",
    derivedReachesServer: false,
    derivedReachesPartner: false,
    logsRawData: false,
    files: ["src/components/FaceEnrollmentDialog.tsx", "src/lib/faceRecognition.ts", "src/workers/faceDetection.worker.ts", "src/lib/faceWorkerClient.ts"],
    knownGaps: [
      "The face template is stored as plaintext JSON in IndexedDB (not encrypted with secureStorage).",
      "MediaPipe model file is fetched from storage.googleapis.com at runtime (a third-party network dependency; no user data is sent).",
    ],
  },
  PHOTO_CAPTURE: {
    id: "PHOTO_CAPTURE",
    sensor: "CAMERA",
    purpose: "Take a photo/video with filters to send or save.",
    activation: "USER_ACTION",
    requiresSettings: [],
    rawClassification: DataClassification.PRIVATE,
    rawDestination: "USER_SENT_MESSAGE",
    derived: "None — the captured media is the user's own content, sent only when they choose to.",
    derivedReachesServer: false,
    derivedReachesPartner: false,
    logsRawData: false,
    files: ["src/components/CameraWithFilters.tsx"],
    knownGaps: [],
  },
  QR_SCAN: {
    id: "QR_SCAN",
    sensor: "CAMERA",
    purpose: "Scan a sign-in QR code.",
    activation: "USER_ACTION",
    requiresSettings: [],
    rawClassification: DataClassification.DEVICE_ONLY,
    rawDestination: "NOWHERE",
    derived: "The decoded QR token is sent to the sign-in function (SECRET-class; never logged).",
    derivedReachesServer: true,
    derivedReachesPartner: false,
    logsRawData: false,
    files: ["src/components/auth/QRSignInScanner.tsx"],
    knownGaps: ["Camera is opened by html5-qrcode / @capacitor/camera directly, not through cameraBus, so it is registered but not runtime-enforced."],
  },
  VOICE_MESSAGE: {
    id: "VOICE_MESSAGE",
    sensor: "MICROPHONE",
    purpose: "Record a voice message to send in chat.",
    activation: "USER_ACTION",
    requiresSettings: [],
    rawClassification: DataClassification.PRIVATE,
    rawDestination: "USER_SENT_MESSAGE",
    derived: "None — the recording is the message; there is no analysis of it.",
    derivedReachesServer: false,
    derivedReachesPartner: false,
    logsRawData: false,
    files: ["src/pages/Chat.tsx", "src/components/chat/VoiceMessagePlayer.tsx"],
    knownGaps: ["Opens the microphone with a direct getUserMedia call (not enforced by cameraBus); registered for inventory."],
  },
  CALL_MEDIA: {
    id: "CALL_MEDIA",
    sensor: "CAMERA+MICROPHONE",
    purpose: "Voice/video calls between the two partners.",
    activation: "USER_ACTION",
    requiresSettings: [],
    rawClassification: DataClassification.PRIVATE,
    rawDestination: "PEER_VIA_CALL_PROVIDER",
    derived: "None. Media is relayed by LiveKit Cloud (managed SFU + TURN); no recording/egress service is deployed. Call-control/signaling stays self-hosted (infrastructure/signaling).",
    derivedReachesServer: false,
    derivedReachesPartner: false,
    logsRawData: false,
    files: [
      "src/lib/callEngine/SelfHostedCallEngineAdapter.ts",
      "src/contexts/CallContext.tsx",
      "src/pages/Calls.tsx",
      "src/components/calls/CallStage.tsx",
      "src/components/calls/MinimizedCallBubble.tsx",
    ],
    knownGaps: ["Call media transits LiveKit Cloud's managed SFU/TURN by design; it is not end-to-end encrypted at the application layer."],
  },
  LIP_READING: {
    id: "LIP_READING",
    sensor: "CAMERA",
    purpose: "On the user's tap during a video call, estimate speech from the PARTNER's lip movement on-device and show captions.",
    activation: "USER_ACTION",
    requiresSettings: [],
    rawClassification: DataClassification.DEVICE_ONLY,
    rawDestination: "DEVICE_MEMORY_ONLY",
    derived: "Caption text held in component state only (copyable to clipboard by the user); never stored or uploaded.",
    derivedReachesServer: false,
    derivedReachesPartner: false,
    logsRawData: false,
    files: ["src/hooks/useLipReading.ts", "src/components/LipReadingOverlay.tsx"],
    knownGaps: [
      "It analyses the PARTNER's face video; the partner is not told or asked. The output is a guess, not a transcript.",
    ],
  },
  PERMISSION_PROBE: {
    id: "PERMISSION_PROBE",
    sensor: "CAMERA+MICROPHONE",
    purpose: "Ask the OS for camera/microphone permission before a user-started feature needs it.",
    activation: "USER_ACTION",
    requiresSettings: [],
    rawClassification: DataClassification.DEVICE_ONLY,
    rawDestination: "NOWHERE",
    derived: "None — the probe stream is stopped immediately.",
    derivedReachesServer: false,
    derivedReachesPartner: false,
    logsRawData: false,
    files: ["src/lib/mediaPermissions.ts"],
    knownGaps: [],
  },
});

export type SensorPurposeId = keyof typeof SENSOR_PURPOSES & string;

/**
 * Files that implement the sensor boundary itself. They are allowed to call
 * getUserMedia / acquireCamera without belonging to a purpose.
 */
export const SENSOR_INFRASTRUCTURE_FILES: readonly string[] = [
  "src/lib/cameraBus.ts",
  "src/lib/privacy/sensorGate.ts",
  "src/lib/privacy/sensorPolicy.ts",
];

/** Purposes that cameraBus.acquireCamera() will accept — the ones that PROCESS or capture the camera through the shared bus. */
export const BUS_CAMERA_PURPOSES = ["PEEK_GUARD", "MOOD_DETECTION", "MOOD_BACKGROUND", "FACE_ENROLLMENT", "PHOTO_CAPTURE"] as const;
export type BusCameraPurpose = (typeof BUS_CAMERA_PURPOSES)[number];

export interface SensorDecision {
  allowed: boolean;
  reason: string;
}

export interface SensorRequestContext {
  /** The call site asserts this session was started by a direct user action. */
  userInitiated?: boolean;
}

/**
 * Decide whether a sensor session for `purposeId` may start right now.
 * FAILS CLOSED: unknown purpose, missing settings snapshot, or any required
 * opt-in that isn't exactly `true` all deny.
 */
export function evaluateSensorRequest(
  purposeId: string,
  settings: SensorSettings | null | undefined,
  ctx: SensorRequestContext = {},
): SensorDecision {
  const spec = Object.prototype.hasOwnProperty.call(SENSOR_PURPOSES, purposeId) ? SENSOR_PURPOSES[purposeId] : undefined;
  if (!spec) return { allowed: false, reason: `Unknown sensor purpose "${purposeId}" — not registered in the sensor policy.` };

  if (spec.activation === "USER_ACTION") {
    if (ctx.userInitiated !== true) {
      return { allowed: false, reason: `"${spec.id}" may only start from a direct user action.` };
    }
    return { allowed: true, reason: "OK" };
  }

  // Automatic activations: every required opt-in must be present AND true.
  for (const key of spec.requiresSettings) {
    if (settings?.[key] !== true) {
      return { allowed: false, reason: `"${spec.id}" requires the "${key}" opt-in, which is not enabled.` };
    }
  }
  return { allowed: true, reason: "OK" };
}

/**
 * Parses the persisted `duo-settings` JSON into just the opt-ins the sensor
 * policy cares about. Anything malformed yields all-false (fail closed);
 * only a literal boolean `true` counts as enabled.
 */
export function parseSensorSettings(raw: string | null | undefined): SensorSettings {
  if (!raw) return NO_SENSOR_SETTINGS;
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return NO_SENSOR_SETTINGS;
    return {
      peekGuard: o.peekGuard === true,
      moodDetection: o.moodDetection === true,
      // The background toggle is only ever valid under its parent.
      moodBackgroundDetection: o.moodDetection === true && o.moodBackgroundDetection === true,
    };
  } catch {
    return NO_SENSOR_SETTINGS;
  }
}
