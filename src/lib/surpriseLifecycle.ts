// ─── Surprise lifecycle adapter ─────────────────────────────────────────────
// Surprise 2.0 (redesign brief) wants a full
//   created → sent → delivered → received → seen → opened → interacting → completed
// state machine. The existing schema only has a `code_surprise_events` log
// with four event_types (received/opened/expanded/finished) plus a client-
// local "seen" flag in sessionStorage — nowhere near 8 columns of state, and
// per the brief ("do not require a database migration if the existing
// schema cannot safely support it yet; create an internal adapter so the
// renderer can accept richer metadata later") that's fine: this derives the
// full 8-stage enum from what already exists, so the DB stays untouched and
// a real `stage` column can replace this later without changing anything
// that reads SurpriseStage.

export type SurpriseStage =
  | "created" | "sent" | "delivered" | "received"
  | "seen" | "opened" | "interacting" | "completed";

export interface DeriveStageInput {
  isMine: boolean;
  /** event_types recorded for this surprise, from fetchSurpriseEventStates */
  events: Set<string> | undefined;
  /** session-local "received" flag — see markReceived/getReceivedIds */
  locallyReceived: boolean;
  /** session-local "seen" flag — see markSeen/getSeenIds */
  locallySeen: boolean;
  /** true only for the currently-expanded surprise, and only while its
   *  overlay is actually open — there is no persisted "interacting" state,
   *  it exists purely for the instant something is live on screen. */
  interacting: boolean;
  /** views_used >= max_views: the surprise has exhausted its allotted
   *  opens, which is this schema's only durable signal for "done". */
  exhausted: boolean;
}

/**
 * A row existing at all means created+sent already happened (there's no
 * draft/unsent state in this schema — insert IS send). From there:
 * - "delivered" fires the instant the recipient's client fetches the row
 *   (implicit: if this function is being asked about a surprise you don't
 *   own, you already have it in front of you — no separate ack needed).
 * - "received"/"seen" are the session-local markers already used to avoid
 *   double-toasting/double-popping the same surprise; reused here so this
 *   adapter needs no new storage of its own.
 * - "opened"/"finished" come straight from the event log.
 * - "completed" is opened+finished, OR the surprise has run out of views —
 *   whichever happens first.
 */
export const deriveSurpriseStage = (input: DeriveStageInput): SurpriseStage => {
  const { isMine, events, locallyReceived, locallySeen, interacting, exhausted } = input;

  const hasOpened = events?.has("opened") ?? false;
  const hasFinished = events?.has("finished") ?? false;

  if (interacting) return "interacting";
  if (hasFinished || exhausted) return "completed";
  if (hasOpened) return "opened";

  // Only the recipient side ever progresses through delivered/received/seen
  // as distinct steps — from the sender's own screen, an un-opened surprise
  // they created just reads as "sent" until the recipient acts on it.
  if (isMine) return "sent";

  if (locallySeen) return "seen";
  if (locallyReceived) return "received";
  return "delivered";
};

/** Short label for the sender-side status pips under an outbound SurpriseMessage. */
export const stageLabel = (stage: SurpriseStage): string => {
  switch (stage) {
    case "created":
    case "sent": return "Sent";
    case "delivered": return "Delivered";
    case "received": return "Delivered";
    case "seen": return "Seen";
    case "opened": return "Opened";
    case "interacting": return "Opened";
    case "completed": return "Completed";
  }
};
