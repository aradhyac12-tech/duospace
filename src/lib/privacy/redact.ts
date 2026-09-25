/**
 * Redaction utility — strips SECRET/DEVICE_ONLY/HIGHLY_SENSITIVE-shaped
 * data out of anything headed for logs, telemetry, or analytics. See
 * .ai/PRIVACY_MODEL.md §Analytics/Logging.
 *
 * This is deliberately key-name-based (a denylist of field names that are
 * never safe to log, matched case-insensitively, plus a couple of
 * value-shape heuristics for things like JWTs) rather than trying to be
 * "smart" about detecting sensitive content — false positives (redacting
 * something harmless) are a debugging inconvenience; false negatives
 * (letting a secret through because a smarter heuristic missed it) are a
 * real leak. When in doubt, this errs toward redacting.
 */

const NEVER_LOG_KEY_PATTERNS: RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
  /jwt/i,
  /auth(orization)?$/i,
  /session[_-]?id$/i, // note: telemetry.ts's own correlation SESSION_ID is a random per-load UUID, not this — this only catches fields literally named session_id/sessionId coming from elsewhere (e.g. an accidentally-included auth session object)
  /credential/i,
  /raw[_-]?(audio|video|mic|camera|frame)/i,
  /(mood|emotion|relationship)[_-]?(observation|insight|inference)/i,
  /message[_-]?(content|body|text)$/i,
  /^body$/i,
  /^content$/i,
  // Phase 1.6 additions — private partner/biometric/location material that
  // has no business in a log line:
  /jwk/i, // E2E private key material (JsonWebKey)
  /passphrase/i,
  /^(otp|pin)$/i,
  /embedding/i, // face templates
  /(transcript|caption)s?$/i, // lip-reading / speech-derived text
  /^(sdp|ice[_-]?candidates?)$/i, // WebRTC signalling can carry IP addresses
  /^(lat|lng|lon|latitude|longitude|coords?)$/i, // location of a person
  /(partner|couple)[_-]?(insight|observation|mood)/i,
  // Phase 2A — relationship reflection. Field names of anything a person
  // wrote about their relationship, or the AI derived from it. Defence in
  // depth only: the feature itself never logs these (see
  // src/lib/relationship/telemetry.ts, which whitelists what may be logged).
  /reflection/i,
  /^(what[_-]?happened|hoped[_-]?for|felt|partner[_-]?understood|next[_-]?time|different[_-]?next[_-]?time)$/i,
  /^(statement|free[_-]?text|observation|uncertainty|evidence|possible[_-]?explanations|suggested[_-]?action)$/i,
  /(values?|expectations?|boundar(y|ies))[_-]?(answers?|items?|statements?)/i,
  /^(prompt|response|raw[_-]?(prompt|response|output))$/i,
];

/** Looks like a JWT (three base64url segments) — redact even if the key name didn't match. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const REDACTED = "[redacted]";

function isNeverLogKey(key: string): boolean {
  return NEVER_LOG_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Deep-redacts an object for safe inclusion in a log line or telemetry
 * event. Arrays and nested objects are walked; primitives are returned
 * as-is unless their *key* matches a never-log pattern, or the *value*
 * itself looks like a JWT.
 */
export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return (JWT_SHAPE.test(value) ? REDACTED : value) as unknown as T;
  }

  if (typeof value !== "object") return value;

  if (seen.has(value as object)) return "[circular]" as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isNeverLogKey(k) ? REDACTED : redact(v, seen);
  }
  return out as unknown as T;
}

/** For a single string value known to be sensitive-by-context even without a key name (e.g. about to log a raw error message that might contain an echoed token). Truncates + redacts JWT-shaped substrings. */
export function redactString(s: string): string {
  return s
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED)
    // "Authorization: Bearer <opaque token>" echoed in a thrown error message.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`);
}
