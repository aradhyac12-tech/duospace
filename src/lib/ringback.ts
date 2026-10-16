/**
 * Caller-side RINGBACK tone ("the other phone is ringing"), chosen by the
 * caller's location the way a phone network (and WhatsApp) does. Pure data +
 * selection logic; sounds.ts only plays it.
 *
 * Patterns follow the national tone plans (ITU-T E.180 supplement values):
 *  - INDIA        400 Hz modulated by 25 Hz (≈ 375 + 425 Hz), 0.4 on · 0.2 off · 0.4 on · 2.0 off
 *                 — the familiar Indian "trring-trring".
 *  - CIS          425 Hz single tone, ~1.0 s on · ~4.0 s off — the long "beep … beep" used in
 *                 Kyrgyzstan and the other former-USSR networks.
 *  - NORTH_AMERICA 440 + 480 Hz, 2.0 s on · 4.0 s off.
 *  - DOUBLE (default, UK/Commonwealth style) 400 + 450 Hz, 0.4 on · 0.2 off · 0.4 on · 2.0 off.
 *
 * Location: the device TIME ZONE first (it reflects where the phone actually
 * is — most Indian phones run an en-US UI language, which previously made them
 * play American beeps), then the locale's region, else DOUBLE. The app's own
 * language setting is never used as a country signal.
 */
export type RingbackName = "INDIA" | "CIS" | "NORTH_AMERICA" | "DOUBLE";

export interface RingbackPattern {
  name: RingbackName;
  /** Sine frequencies mixed together. */
  freqs: number[];
  /** Amplitude-modulation rate in Hz (INDIA only), else 0. */
  amHz: number;
  /** Alternating ON/OFF durations in seconds, starting with ON; repeats. */
  cadence: number[];
}

export const RINGBACK: Record<RingbackName, RingbackPattern> = {
  INDIA: { name: "INDIA", freqs: [400], amHz: 25, cadence: [0.4, 0.2, 0.4, 2.0] },
  CIS: { name: "CIS", freqs: [425], amHz: 0, cadence: [1.0, 4.0] },
  NORTH_AMERICA: { name: "NORTH_AMERICA", freqs: [440, 480], amHz: 0, cadence: [2.0, 4.0] },
  DOUBLE: { name: "DOUBLE", freqs: [400, 450], amHz: 0, cadence: [0.4, 0.2, 0.4, 2.0] },
};

export const periodSeconds = (p: RingbackPattern) => p.cadence.reduce((a, b) => a + b, 0);

const TZ_REGION: Record<string, string> = {
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN",
  "Asia/Bishkek": "KG", "Asia/Frunze": "KG",
  "Asia/Almaty": "KZ", "Asia/Qostanay": "KZ", "Asia/Qyzylorda": "KZ", "Asia/Aqtobe": "KZ", "Asia/Aqtau": "KZ", "Asia/Atyrau": "KZ", "Asia/Oral": "KZ",
  "Asia/Tashkent": "UZ", "Asia/Samarkand": "UZ", "Asia/Dushanbe": "TJ", "Asia/Ashgabat": "TM",
  "Europe/Moscow": "RU", "Europe/Kaliningrad": "RU", "Europe/Samara": "RU", "Asia/Yekaterinburg": "RU", "Asia/Novosibirsk": "RU", "Asia/Omsk": "RU", "Asia/Krasnoyarsk": "RU", "Asia/Irkutsk": "RU", "Asia/Vladivostok": "RU",
  "Europe/Minsk": "BY", "Europe/Kiev": "UA", "Europe/Kyiv": "UA", "Europe/Chisinau": "MD",
  "Asia/Yerevan": "AM", "Asia/Baku": "AZ", "Asia/Tbilisi": "GE",
};
const CIS = new Set(["KG", "KZ", "UZ", "TJ", "TM", "RU", "BY", "UA", "MD", "AM", "AZ", "GE"]);
const NA = new Set(["US", "CA"]);

export function detectRingRegion(env: { timeZone?: string | null; languages?: readonly string[] } = {}): string | null {
  let tz = env.timeZone;
  if (tz === undefined) { try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = null; } }
  if (tz && TZ_REGION[tz]) return TZ_REGION[tz];
  if (tz && /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Detroit|Indiana)/.test(tz)) return "US";
  let langs = env.languages;
  if (langs === undefined) { try { langs = typeof navigator !== "undefined" ? [...(navigator.languages ?? []), navigator.language].filter(Boolean) : []; } catch { langs = []; } }
  for (const l of langs ?? []) { const r = l.split(/[-_]/)[1]; if (r && /^[A-Za-z]{2}$/.test(r)) return r.toUpperCase(); }
  return null;
}

export function ringbackFor(region: string | null): RingbackPattern {
  if (region === "IN") return RINGBACK.INDIA;
  if (region && CIS.has(region)) return RINGBACK.CIS;
  if (region && NA.has(region)) return RINGBACK.NORTH_AMERICA;
  return RINGBACK.DOUBLE;
}
