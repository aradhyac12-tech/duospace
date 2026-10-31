/**
 * Daily check-in — the everyday, zero-typing entry point to relationship help.
 *
 * Design rules (why it can be trusted):
 *  - Input is only what the user TAPPED: one mood + up to two needs. No free
 *    text, so nothing is inferred about anyone.
 *  - Output is a fixed, reviewed template chosen by those taps — never
 *    generated, never about the partner's feelings or motives, no scores.
 *  - The suggested message is a DRAFT: it is only ever put into the chat
 *    composer; the user decides whether to send it.
 *  - No streaks, no nagging: one card a day, "done" after one tap.
 * Stored on-device only (encrypted backend), last check-in only.
 */
export type Mood = "good" | "okay" | "off" | "hard";
export type Need = "time" | "space" | "kind_word" | "help" | "listen" | "talk";

export const MOODS: { id: Mood; emoji: string; label: string }[] = [
  { id: "good", emoji: "😊", label: "Good" },
  { id: "okay", emoji: "🙂", label: "Okay" },
  { id: "off", emoji: "😕", label: "A bit off" },
  { id: "hard", emoji: "😔", label: "Hard" },
];

export const NEEDS: { id: Need; label: string }[] = [
  { id: "time", label: "Time together" },
  { id: "space", label: "Some space" },
  { id: "kind_word", label: "A kind word" },
  { id: "help", label: "A hand with something" },
  { id: "listen", label: "Someone to listen" },
  { id: "talk", label: "To sort something out" },
];

const NEED_SUGGESTION: Record<Need, { tip: string; message: string }> = {
  time: { tip: "Ask for it plainly and suggest a time — it's easier to say yes to.", message: "Can we have some time together tonight, just us?" },
  space: { tip: "Ask for space kindly and say when you'll be back, so it doesn't feel like distance.", message: "I need a little time to myself tonight. It's not about you — can we talk after?" },
  kind_word: { tip: "Saying what would help works better than hoping they guess.", message: "Today's been a lot. A kind word from you would really help right now." },
  help: { tip: "Be specific about what would help — it's easier to act on.", message: "Could you help me with something today? It would take a load off." },
  listen: { tip: "Say whether you want advice or just an ear.", message: "Can I tell you about my day? I don't need advice, just you listening." },
  talk: { tip: "Pick a calm moment, and start with how it felt for you rather than what they did.", message: "Something's been on my mind. Can we talk later when we're both free?" },
};

const MOOD_ONLY: Record<Mood, { tip: string; message: string | null }> = {
  good: { tip: "Good days are worth naming — a small thank-you goes a long way.", message: "I really appreciated you today." },
  okay: { tip: "A small check-in keeps you close on ordinary days too.", message: "How was your day? I'd love to hear about it." },
  off: { tip: "If something's on your mind, pick what would help below — or just let it be for today.", message: null },
  hard: { tip: "Hard days are allowed. If something happened between you, 'Help me put it into words' can help you prepare — at your own pace.", message: null },
};

export interface CheckIn { date: string; mood: Mood; needs: Need[] }
export interface Suggestion { tip: string; message: string | null; offerRepair: boolean; basedOn: string }

/** One suggestion, chosen only by the taps. The first need wins; mood alone otherwise. */
export function suggestFor(c: Pick<CheckIn, "mood" | "needs">): Suggestion {
  const needs = c.needs.filter((n): n is Need => n in NEED_SUGGESTION).slice(0, 2);
  const labels = needs.map((n) => NEEDS.find((x) => x.id === n)!.label.toLowerCase());
  const moodLabel = MOODS.find((m) => m.id === c.mood)?.label.toLowerCase() ?? "okay";
  const basedOn = `Because you chose: ${moodLabel}${labels.length ? ` · ${labels.join(", ")}` : ""}.`;
  if (needs.length) {
    const s = NEED_SUGGESTION[needs[0]];
    return { tip: s.tip, message: s.message, offerRepair: c.mood === "hard" || needs[0] === "talk", basedOn };
  }
  const m = MOOD_ONLY[c.mood] ?? MOOD_ONLY.okay;
  return { tip: m.tip, message: m.message, offerRepair: c.mood === "hard", basedOn };
}

export const todayKey = (now: Date = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export const CHECKIN_KEY = "rel_checkin_v1";
