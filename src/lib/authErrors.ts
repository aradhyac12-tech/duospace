// Maps Supabase Auth errors to clean, user-facing text. Previously every
// auth screen (sign in, sign up, forgot password, reset password, OAuth)
// showed `error.message` straight to the user — raw GoTrue error strings
// like "invalid_grant", "flow_state_not_found", or "otp_expired" are
// technical and not actionable for someone trying to sign in.
//
// This never removes detail from logs — every call site here already logs
// the full error (status/code/name/message) via `supaErr()` separately;
// this only governs what gets shown in a toast.
export function getAuthErrorMessage(err: unknown): string {
  const raw = extractMessage(err).toLowerCase();
  const code = extractCode(err);

  // Network-level failures (no response at all) — distinct from the app
  // rejecting the request.
  if (raw.includes("failed to fetch") || raw.includes("networkerror") || raw.includes("network request failed")) {
    return "Network error. Check your connection and try again.";
  }

  if (raw.includes("invalid login credentials")) {
    return "Incorrect email or password.";
  }
  if (raw.includes("email not confirmed")) {
    return "Please confirm your email before signing in.";
  }
  if (raw.includes("user already registered") || raw.includes("already been registered")) {
    return "An account with this email already exists. Try signing in instead.";
  }
  if (raw.includes("password should be at least") || raw.includes("password is too short") || code === "weak_password") {
    return "Password is too short — use at least 6 characters.";
  }
  if (
    code === "otp_expired" ||
    code === "flow_state_not_found" ||
    raw.includes("expired") ||
    raw.includes("invalid_grant") ||
    raw.includes("invalid or expired")
  ) {
    return "This link has expired or was already used. Please request a new one.";
  }
  if (code === "access_denied" || raw.includes("access_denied") || raw.includes("cancelled")) {
    return "Sign-in was cancelled.";
  }
  if (raw.includes("email address not authorized") || raw.includes("not authorized")) {
    return "We couldn't send that email right now. Please try again shortly.";
  }
  if (raw.includes("rate limit") || raw.includes("for security purposes") || raw.includes("too many")) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (raw.includes("user not found")) {
    // Deliberately the same generic wording a real reset-password send would
    // use for an unknown address (see Auth.tsx forgot-password handler) —
    // an error here should never confirm or deny whether an email is
    // registered.
    return "If an account exists for that email, a reset link is on its way.";
  }

  // Anything unrecognized: don't pass raw GoTrue internals through.
  return "Something went wrong. Please try again.";
}

function extractMessage(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    return typeof m === "string" ? m : "";
  }
  return "";
}

function extractCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}
