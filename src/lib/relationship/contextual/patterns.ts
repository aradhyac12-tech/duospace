/**
 * The ONE set of message-language patterns. Consumed only by the canonical
 * extractor (./extract.ts); the responsiveness engine reads the extractor's
 * result, not these regexes. Kept in a leaf module (no imports) so there is
 * no circular import between extract.ts and responsiveness/engine.ts.
 */
export const PAST_WISH = /\bI\s+(?:just\s+|really\s+)?(?:wanted|was hoping|hoped|wished|would have liked)\s+(?:for\s+)?you\s+to\s+([^.!?]+)/i;
export const PAST_MISS = /\byou\s+(?:didn'?t|did not|forgot to|never)\s+([^.!?]+)/i;
export const FUTURE_REQ = /\b(?:can|could|shall)\s+we\s+([^.!?]+)\?|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?([^.!?]+)\?|\bplease\s+([^.!?]+)|\bI\s+(?:need|want|would like|'d like)\s+you\s+to\s+([^.!?]+)|\byou\s+should\s+([^.!?]+)/i;
export const STATED_FEELING = /\bI\s+(?:feel|felt|am|'m|was)\s+(?:so\s+|really\s+|a bit\s+|kind of\s+)?(sad|hurt|upset|angry|lonely|ignored|unheard|stressed|overwhelmed|tired|exhausted|disappointed|frustrated|worried|anxious|jealous|scared|happy|excited|confused|annoyed|left out|forgotten)\b|\bI\s+had\s+(?:a|such a)\s+(terrible|bad|hard|difficult|awful|rough|long|great|good)\s+day\b/i;
export const ACCUSATION = /\byou\s+(always|never)\b|\byou\s+(don'?t|do not)\s+(care|listen|love)\b|\b(it'?s|this is)\s+(all\s+)?your\s+fault\b|\byou\s+only\s+care\s+about\b/i;
export const CONTROL = /\b(share|send)\s+(me\s+)?your\s+(live\s+)?location\b|\blocation\s+(on|sharing)\b|\b(give|tell)\s+me\s+your\s+(password|passcode|pin)\b|\b(check|see|look at|go through)\s+your\s+(phone|messages|chats|dms)\b|\bwho\s+(were|are)\s+you\s+(with|texting|talking to)\b|\bstop\s+(seeing|talking to)\s+(your\s+)?friends\b/i;
export const ACK = /\b(I hear you|I understand|thank you for telling me|that makes sense|I see)\b/i;
export const DEFENSIVE = /\b(but I was|I was (just )?busy|it'?s not my fault|that'?s not fair|you'?re overreacting)\b/i;

export const PATTERNS = { PAST_WISH, PAST_MISS, FUTURE_REQ, STATED_FEELING, ACCUSATION, CONTROL, ACK, DEFENSIVE } as const;

/** Topic domains (first match wins; request object checked before the whole message). Moved verbatim from the responsiveness engine. */
export type Domain = "CONTACT" | "WORK_STRESS" | "PLANS" | "CHORES" | "SPACE" | "LISTENING" | "FAMILY_FRIENDS";
export const DOMAIN_PATTERNS: { id: Domain; re: RegExp }[] = [
  { id: "CONTACT", re: /\b(call|called|text|texted|message|messaged|reply|replied|contact|check in)\b/i },
  { id: "WORK_STRESS", re: /\b(day|work|exam|test|stress|stressed|tired|exhausted|overwhelmed)\b/i },
  { id: "PLANS", re: /\b(plan|plans|dinner|date|cancel|cancelled|canceled|weekend|together|time with)\b/i },
  { id: "CHORES", re: /\b(chores|dishes|clean|cleaning|house|laundry|cook|groceries|bills|money|pay)\b/i },
  { id: "SPACE", re: /\b(space|alone|time to myself|breathe)\b/i },
  { id: "LISTENING", re: /\b(listen|listened|hear|heard|unheard|ignored)\b/i },
  { id: "FAMILY_FRIENDS", re: /\b(family|parents|mum|mom|dad|in-laws|friends)\b/i },
];
