/**
 * Recovery strategies.
 *
 * Each `RecoveryAction` (see types.ts) maps to a handler here. Handlers are
 * registered by the feature modules that know how to actually recover
 * (e.g. ThemeContext registers "restore-previous-theme", useAuth registers
 * "refresh-session") — this file only defines the shape + the built-in
 * fallbacks that work with no feature-specific wiring.
 *
 * Usage from a feature module (e.g. useAuth.ts):
 *   import { registerRecovery } from "@/lib/errors/recovery";
 *   registerRecovery("refresh-session", async () => {
 *     const { error } = await supabase.auth.refreshSession();
 *     return !error;
 *   });
 */
import type { RecoveryAction } from "./types";

export type RecoveryHandler = () => Promise<boolean>;

const handlers = new Map<RecoveryAction, RecoveryHandler>();

// Built-in fallback: simple network retry just waits for `online` or resolves
// immediately if already online. Feature call sites that have a concrete
// retry function (a specific fetch, upload, invoke) should still call it
// directly — this exists for the generic "auto-recovery ran" bookkeeping.
handlers.set("retry-network", async () => {
  if (typeof navigator === "undefined" || navigator.onLine) return true;
  return new Promise((resolve) => {
    const onOnline = () => {
      window.removeEventListener("online", onOnline);
      resolve(true);
    };
    window.addEventListener("online", onOnline);
    window.setTimeout(() => {
      window.removeEventListener("online", onOnline);
      resolve(false);
    }, 10_000);
  });
});

handlers.set("none", async () => false);

/** Register (or override) the handler for a recovery action. */
export function registerRecovery(action: RecoveryAction, handler: RecoveryHandler): void {
  handlers.set(action, handler);
}

/** Whether a real (non-fallback, non-"none") handler has been registered for this action. */
export function hasRecovery(action: RecoveryAction): boolean {
  return action !== "none" && handlers.has(action);
}

const recoveryStats = { attempts: 0, successes: 0 };
export function getRecoveryStats(): Readonly<typeof recoveryStats> {
  return { ...recoveryStats };
}

/** Run the recovery strategy for an action. Never throws. */
export async function runRecovery(action: RecoveryAction): Promise<boolean> {
  if (action === "none") return false;
  const handler = handlers.get(action);
  if (!handler) return false;
  recoveryStats.attempts += 1;
  try {
    const ok = await handler();
    if (ok) recoveryStats.successes += 1;
    return ok;
  } catch {
    return false;
  }
}
