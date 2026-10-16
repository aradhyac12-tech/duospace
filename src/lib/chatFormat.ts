/**
 * Shared, cached date/time formatters for the chat timeline.
 *
 * PERF: `Date.prototype.toLocaleTimeString(locales, options)` and
 * `toLocaleDateString(...)` construct a brand-new Intl.DateTimeFormat on
 * EVERY call — one of the slower things you can do in a hot render path
 * (tens to hundreds of microseconds each on a mid-range Android WebView).
 * The chat called them once per bubble per render and once per timeline item
 * while grouping, so a long conversation paid that cost thousands of times
 * on every message arrival, upload-progress tick and Hub open. A single
 * shared Intl.DateTimeFormat instance is constructed once and reused; its
 * output is identical to the toLocale*String calls it replaces (same
 * default locale, same options).
 */
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** "09:41 PM" style clock time for an ISO timestamp (or anything Date accepts). */
export const formatClockTime = (iso: string | number | Date): string => timeFormatter.format(new Date(iso));

/** "Tue, Sep 30, 2026" style day-header label used to group the timeline by day. */
export const formatDayLabel = (iso: string | number | Date): string => dateFormatter.format(new Date(iso));
