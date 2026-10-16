import { isOnlineNow } from "@/lib/connectivity";
import { toast } from "@/hooks/use-toast";

/**
 * For actions that can only happen on the server (pairing, invites, unlinking,
 * search, sign-out). Returns true when it's fine to proceed; otherwise shows one
 * clear "you're offline" message — instead of letting the request fail and
 * surface as a confusing "Failed" / "Check your connection" toast, or (worse)
 * being retried behind the person's back.
 */
export function requireOnline(what: string): boolean {
  if (isOnlineNow()) return true;
  toast({ title: "You're offline", description: `${what} needs an internet connection. Try again once you're back online.` });
  return false;
}
