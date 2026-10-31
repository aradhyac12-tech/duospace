/**
 * Chat cache — the best-effort facade Chat.tsx uses to talk to the on-device
 * message store (src/lib/localDb/messageStore.ts).
 *
 * Every function here:
 *   - is a no-op / empty result when PERSIST_CHAT_CACHE is false, and
 *   - NEVER throws — a storage failure must degrade to "no local copy" (the
 *     app then behaves exactly like it did before there was a cache), never
 *     break the chat.
 *
 * PRIVACY TRADE-OFF — read before changing (updated 2026-09-21):
 *   Chat.tsx's own in-session `messageCache` is memory-only on purpose: it holds
 *   DECRYPTED text from an end-to-end-encrypted conversation. This layer is the
 *   opt-in exception, added at the owner's request so the app can open like
 *   WhatsApp — instantly and offline. It used to keep only the latest 60
 *   messages; it now keeps the whole history the person has loaded (bounded at
 *   MAX_STORED_MESSAGES_PER_CONVERSATION). What stays the same:
 *     - encrypted at rest (AES-256-GCM, per-user key from secureStorage);
 *       sign-out destroys the key AND deletes the rows;
 *     - NEVER any disappearing/vanish/pending message, never an unsent/failed
 *       optimistic bubble, never a local blob preview URL, never a message
 *       still showing a decrypt-failure placeholder (see isStorable());
 *     - server transport is unchanged — this is purely a local read cache and
 *       the network stays the source of truth (Chat.tsx reconciles against it).
 *   Set PERSIST_CHAT_CACHE to false to turn the whole thing off.
 */
import { secureGet, secureRemove } from "@/lib/privacy/secureStorage";
import { messageStore } from "@/lib/localDb";
import { logWarn } from "@/lib/telemetry";
import { getOfflinePref } from "@/lib/offlineSettings";
import type { DecryptedMessage } from "@/types/chat";

export const PERSIST_CHAT_CACHE = true;

/** Build-time kill switch AND the person's own "Keep chat history on this device" choice. */
const enabled = () => PERSIST_CHAT_CACHE && getOfflinePref("chatHistory");

export interface LocalChatPage {
  messages: DecryptedMessage[];
  /** More (older) messages exist locally beyond this page. */
  hasMore: boolean;
}

const EMPTY: LocalChatPage = { messages: [], hasMore: false };

// ─── One-time import of the previous 60-message cache ───────────────────────

const legacyKey = (partnerId: string) => `chat-cache-v1-${partnerId}`;
const migrated = new Set<string>();

/**
 * The previous version kept the latest 60 messages as one encrypted blob in
 * Preferences. Pull it into the new store once (so the first launch after the
 * update is not empty) and delete it.
 */
async function migrateLegacyChatCache(uid: string, partnerId: string): Promise<void> {
  const memo = `${uid}|${partnerId}`;
  if (migrated.has(memo)) return;
  migrated.add(memo);
  try {
    const legacy = await secureGet<DecryptedMessage[]>(uid, legacyKey(partnerId));
    if (Array.isArray(legacy) && legacy.length > 0) {
      await messageStore.putMessages(uid, partnerId, legacy.filter((m) => m && typeof m.id === "string"));
    }
    await secureRemove(uid, legacyKey(partnerId));
  } catch {
    /* nothing to migrate / could not read — harmless */
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Newest `limit` locally stored messages (oldest → newest). */
export async function readLocalChatPage(uid: string, partnerId: string, limit: number): Promise<LocalChatPage> {
  if (!enabled()) return EMPTY;
  try {
    await migrateLegacyChatCache(uid, partnerId);
    return await messageStore.getRecent(uid, partnerId, limit);
  } catch (err) {
    logWarn("chatCache", "local read failed — continuing without it", err);
    return EMPTY;
  }
}

/** `limit` locally stored messages strictly older than `beforeCreatedAt`. */
export async function readLocalChatBefore(
  uid: string, partnerId: string, beforeCreatedAt: string, limit: number,
): Promise<LocalChatPage> {
  if (!enabled()) return EMPTY;
  try {
    return await messageStore.getBefore(uid, partnerId, beforeCreatedAt, limit);
  } catch (err) {
    logWarn("chatCache", "local paged read failed", err);
    return EMPTY;
  }
}

/** created_at of the newest stored message — the cursor for delta sync. */
export async function newestLocalCreatedAt(uid: string, partnerId: string): Promise<string | null> {
  if (!enabled()) return null;
  try {
    return await messageStore.getNewestCreatedAt(uid, partnerId);
  } catch {
    return null;
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Upsert whatever in `messages` is safe to keep. */
export async function persistMessages(uid: string, partnerId: string, messages: DecryptedMessage[]): Promise<void> {
  if (!enabled()) return;
  try {
    await messageStore.putMessages(uid, partnerId, messages);
  } catch (err) {
    logWarn("chatCache", "local write failed — chat unaffected", err);
  }
}

export async function removePersistedMessages(uid: string, ids: string[]): Promise<void> {
  if (!enabled() || ids.length === 0) return;
  try {
    await messageStore.deleteMessages(uid, ids);
  } catch { /* best-effort */ }
}

/**
 * The server just answered for a window of the conversation; drop any local
 * row inside that window the server no longer has (deleted / cleared).
 * `windowStartCreatedAt = null` means the server returned the entire
 * conversation.
 *
 * `serverIds` must be EVERY id the server returned for the window — including
 * ones Chat.tsx chose not to display or store (expired/disappearing rows,
 * decrypt-failure placeholders). "Not stored" is not "gone", and treating it
 * as gone would delete a perfectly good local copy after a decrypt hiccup.
 */
export async function reconcilePersistedWindow(
  uid: string, partnerId: string, serverIds: string[], windowStartCreatedAt: string | null,
): Promise<void> {
  if (!enabled()) return;
  try {
    await messageStore.reconcileWindow(uid, partnerId, new Set(serverIds), windowStartCreatedAt);
  } catch { /* best-effort */ }
}

export async function clearPersistedConversation(uid: string, partnerId: string): Promise<void> {
  try {
    await messageStore.clearConversation(uid, partnerId);
  } catch { /* best-effort */ }
}

/** How many messages are stored on this device for this conversation. */
export async function countLocalMessages(uid: string, partnerId: string): Promise<number> {
  try {
    return await messageStore.countMessages(uid, partnerId);
  } catch {
    return 0;
  }
}
