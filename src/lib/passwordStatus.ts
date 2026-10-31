import type { User } from "@supabase/supabase-js";

/** Password rule shared by sign-up, reset, onboarding and change-password. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    return "Use at least 8 characters with letters and numbers.";
  }
  return null;
}

/**
 * True when this account can sign in with email + password: either it was
 * created with an email identity, or a password was added later through the
 * OTP-verified set-email-password function (which stamps user_metadata.has_password).
 */
export function userHasPassword(user: User | null | undefined): boolean {
  if (!user) return false;
  const providers = (((user.app_metadata as any)?.providers ?? []) as string[]);
  return providers.includes("email") || (user.user_metadata as any)?.has_password === true;
}

const PROMPT_SEEN_KEY = (userId: string) => `duo-password-prompt-seen:${userId}`;

export function hasSeenPasswordPrompt(userId: string): boolean {
  try { return localStorage.getItem(PROMPT_SEEN_KEY(userId)) === "1"; } catch { return false; }
}
export function markPasswordPromptSeen(userId: string): void {
  try { localStorage.setItem(PROMPT_SEEN_KEY(userId), "1"); } catch { /* storage unavailable */ }
}
