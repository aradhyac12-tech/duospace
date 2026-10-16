/**
 * Approved user-facing statement templates. The AI layer may rephrase these
 * but may not add content (see aiAdapter.ts). Plain, non-clinical, no scores.
 * English source strings; localisation reuses src/lib/relationship/i18n.
 */
export interface StatementTemplate { statement: string; detail?: string }

export const STATEMENTS: Readonly<Record<string, StatementTemplate>> = {
  "comm.rhythm.different": { statement: "Your communication rhythms seem different.", detail: "One of you may prefer frequent short chats, while the other prefers fewer longer conversations." },
  "comm.rhythm.aligned": { statement: "You both described a similar communication rhythm." },
  "conflict.first_step.different": { statement: "You described different first steps after a disagreement.", detail: "One of you may want to talk it through right away, while the other may want some space first." },
  "conflict.first_step.aligned": { statement: "You described a similar first step after a disagreement." },
  "resp.in_person.positive": { statement: "Attentiveness in person was mentioned as a strength." },
  "resp.feels_understood.positive": { statement: "You said you feel understood by your partner." },
  "resp.feels_understood.negative": { statement: "You said you don't always feel understood by your partner.", detail: "That is how it feels to you; it doesn't tell us what your partner intends." },
  "supp.capitalization.positive": { statement: "You said your partner responds warmly when you share good news." },
  "qt.often.positive": { statement: "Time together was described as frequent." },
  "qt.rarely.negative": { statement: "Time together was described as infrequent.", detail: "That describes how it is now, not why." },
  "dir.space.insufficient": { statement: "Wanting some space was mentioned.", detail: "On its own that doesn't say anything about where the relationship is heading." },
  "mixed.generic": { statement: "There are both similarities and differences here." },
  "unknown.generic": { statement: "There isn't enough information yet." },
  "contradictory.generic": { statement: "What you've each shared doesn't line up yet, so it's worth checking in." },
  "safety.review": { statement: "Some of what you described may be about your safety, so we're holding back ordinary relationship tips.", detail: "You decide what to do next. Support options are below." },
};
