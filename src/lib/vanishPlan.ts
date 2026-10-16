// Pure planning logic for ending a Vanish session and for sweeping messages
// that were kept because the recipient hadn't seen them yet. No I/O here so
// it can be unit-tested in isolation — vanishPurge.ts does the network work,
// and supabase/functions/purge-vanish-messages/index.ts applies the SAME
// rules server-side (keep the two in sync).
//
// Definitions
//   seen   = the recipient has opened it (messages.is_read = true).
//   me     = the person turning Vanish Mode off / leaving the chat.
import { VANISH_SENTINEL, VANISH_AFTER_SEEN_SENTINEL } from "@/lib/chatConstants";

export interface VanishRow {
  id: string;
  sender_id: string;
  receiver_id: string;
  file_url: string | null;
  is_read: boolean;
  disappear_at: string | null;
}

export interface VanishEndPlan {
  /** Seen vanish messages → delete the row AND its media file. */
  deleteRows: VanishRow[];
  /** MY unseen messages → keep, re-label "vanish_after_seen". */
  markAfterSeenIds: string[];
  /** Unseen messages left exactly as they are (the partner's own running session). */
  untouchedIds: string[];
}

/**
 * Turning Vanish Mode OFF.
 *  - every vanish message that HAS been seen goes, both directions (unchanged
 *    behaviour — this is the "everything vanishes" the feature promises);
 *  - a message nobody has seen yet is NEVER deleted. Mine are re-labelled so
 *    they vanish once seen; the partner's are their own running session, so
 *    they're left alone;
 *  - a "vanish_after_seen" message goes only when I'm the one who has read it.
 */
export function planEndVanish(rows: VanishRow[], me: string): VanishEndPlan {
  const plan: VanishEndPlan = { deleteRows: [], markAfterSeenIds: [], untouchedIds: [] };
  for (const r of rows) {
    if (r.disappear_at === VANISH_SENTINEL) {
      if (r.is_read) plan.deleteRows.push(r);
      else if (r.sender_id === me) plan.markAfterSeenIds.push(r.id);
      else plan.untouchedIds.push(r.id);
    } else if (r.disappear_at === VANISH_AFTER_SEEN_SENTINEL) {
      if (r.is_read && r.receiver_id === me) plan.deleteRows.push(r);
      else plan.untouchedIds.push(r.id);
    }
  }
  return plan;
}

/**
 * Leaving the chat / opening it fresh: delete the "vanish_after_seen"
 * messages that I (the recipient) have already read. Only the reader ever
 * triggers this, so nobody loses a message they're still looking at.
 */
export function planSweepSeen(rows: VanishRow[], me: string): VanishRow[] {
  return rows.filter(
    (r) => r.disappear_at === VANISH_AFTER_SEEN_SENTINEL && r.is_read && r.receiver_id === me,
  );
}

/**
 * A "vanish_after_seen" message I've already read in an EARLIER visit is
 * spent — it must not be shown again. `readThisVisit` holds ids I marked read
 * during the current visit, which stay on screen until I leave.
 */
export function isSpentVanishForViewer(
  m: { id: string; receiver_id: string; is_read: boolean; disappear_at: string | null },
  viewerId: string,
  readThisVisit: ReadonlySet<string>,
): boolean {
  return (
    m.disappear_at === VANISH_AFTER_SEEN_SENTINEL &&
    m.is_read &&
    m.receiver_id === viewerId &&
    !readThisVisit.has(m.id)
  );
}
