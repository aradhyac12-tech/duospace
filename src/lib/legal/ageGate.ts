// Neutral age gate for account creation (video checklist item 1: COPPA et al).
//
// Design: we ask for a date of birth, check it, and keep ONLY the fact that the
// check passed (metadata `age_gate`) — never the date of birth itself. A failed
// attempt sets a device-local block so the person can't just retype a different
// date. This is a deterrent + record of reasonable care, not identity proof.
//
// MIN_AGE is a single product/legal decision. 18 is the safest default for a
// couples app with a payments flow (India's DPDP Act treats <18 as children;
// GDPR-K ranges 13-16; COPPA is <13). Lower it deliberately, not by accident.

export const MIN_AGE = 18;
export const AGE_GATE_VERSION = 1;
export const AGE_BLOCK_KEY = "duo-age-blocked";
export const AGE_OK_KEY = "duo-age-ok";
/** How long a failed attempt blocks this device from trying again. */
export const AGE_BLOCK_MS = 24 * 60 * 60 * 1000;

/** Whole years between `birth` (YYYY-MM-DD) and `now`. null for invalid/future dates. */
export function ageFromDob(birth: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Reject 2001-02-31 style rollovers.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  let age = now.getUTCFullYear() - y;
  const hadBirthday = now.getUTCMonth() > mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() >= d);
  if (!hadBirthday) age -= 1;
  if (age < 0 || age > 120) return null;
  return age;
}

export type AgeCheck = { ok: true } | { ok: false; reason: "invalid" | "too_young" };

export function checkAge(birth: string, now: Date = new Date(), minAge: number = MIN_AGE): AgeCheck {
  const age = ageFromDob(birth, now);
  if (age === null) return { ok: false, reason: "invalid" };
  return age >= minAge ? { ok: true } : { ok: false, reason: "too_young" };
}

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function isBlocked(store: KV | null, now: number = Date.now()): boolean {
  try {
    const raw = store?.getItem(AGE_BLOCK_KEY);
    if (!raw) return false;
    return now - Number(raw) < AGE_BLOCK_MS;
  } catch {
    return false;
  }
}

export function recordBlock(store: KV | null, now: number = Date.now()): void {
  try { store?.setItem(AGE_BLOCK_KEY, String(now)); } catch { /* storage unavailable */ }
}

/** Metadata stored on the auth user: that the gate passed, never the DOB. */
export function ageGateMetadata(now: Date = new Date()) {
  return { age_gate: { version: AGE_GATE_VERSION, min_age: MIN_AGE, confirmed_at: now.toISOString() } };
}

export const AGE_BLOCK_MESSAGE =
  `DuoSpace is for people ${MIN_AGE} and older, so we can't create an account for you.`;
