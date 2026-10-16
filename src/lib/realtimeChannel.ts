/**
 * Unique topic names for LOCAL postgres_changes channels.
 *
 * supabase-js keeps a registry keyed by topic: `supabase.channel(name)` returns the
 * EXISTING channel if one with that name is still registered, and
 * `removeChannel()` is async. So when an effect re-runs (user/deps change,
 * StrictMode remount, fast navigation) the next `channel(sameName)` can be handed
 * the old, already-subscribed channel, and `.on("postgres_changes", …)` then throws
 *   "cannot add `postgres_changes` callbacks for realtime:<name> after `subscribe()`"
 * which unmounts the whole screen via the ErrorBoundary.
 *
 * Only use this for channels whose name is purely local (postgres_changes). NEVER for
 * broadcast/presence channels — those topics must be identical on both phones.
 */
let seq = 0;
const nonce = Math.random().toString(36).slice(2, 8);
export const uniqueChannelName = (base: string): string => `${base}#${nonce}${++seq}`;
