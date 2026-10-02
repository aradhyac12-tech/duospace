/**
 * App wiring for the local message store: IndexedDB backend + the per-user
 * master key from secureStorage + the media cache for offline photos/voice.
 *
 * Kept separate from messageStore.ts so that file stays free of app
 * dependencies (and therefore unit-testable without IndexedDB / Supabase).
 */
import { createMessageStore, createMemoryBackend } from "@/lib/localDb/messageStore";
import { createIdbBackend } from "@/lib/localDb/idbMessageBackend";
import { createCollectionStore, createMemoryCollectionBackend } from "@/lib/localDb/collectionStore";
import { createIdbCollectionBackend } from "@/lib/localDb/idbCollectionBackend";
import { getOrCreateMasterKey } from "@/lib/privacy/secureStorage";
import { getLocalMediaUrl, pathFromLocalUrl, wipeMediaCache } from "@/lib/mediaCache";
import { extractStoragePath } from "@/lib/signedStorageUrl";

const CHAT_BUCKET = "chat-files";

export const messageStore = createMessageStore({
  // No IndexedDB (some locked-down private modes) → in-memory only: the app
  // still works, the cache just doesn't survive a restart.
  backend: typeof indexedDB !== "undefined" ? createIdbBackend() : createMemoryBackend(),
  getKey: getOrCreateMasterKey,
  mediaPathFromUrl: (url) => {
    const local = pathFromLocalUrl(url);
    if (local) return local.bucket === CHAT_BUCKET ? local.path : null;
    return extractStoragePath(CHAT_BUCKET, url);
  },
  localMediaUrl: (path) => getLocalMediaUrl(CHAT_BUCKET, path),
});

/** Encrypted per-screen snapshots (Shayari, Us, Gallery lists…). See collectionStore.ts. */
export const collectionStore = createCollectionStore({
  backend: typeof indexedDB !== "undefined" ? createIdbCollectionBackend() : createMemoryCollectionBackend(),
  getKey: getOrCreateMasterKey,
});

/**
 * Remove every on-device copy of this user's conversation data: stored
 * messages and cached media. Called on sign-out (alongside secureWipeAll,
 * which destroys the key the stored messages are encrypted with) and when a
 * pairing ends.
 */
export async function wipeLocalConversationData(uid: string): Promise<void> {
  await Promise.allSettled([messageStore.wipeUser(uid), collectionStore.wipeUser(uid), wipeMediaCache()]);
}
