// Shared helper to turn a caught `unknown` into a readable string.
//
// BUG FIX: several call sites did `String(err)` as a fallback for
// non-Error values. Daily.co's call-object SDK rejects `call.join()` with
// a plain object shaped like `{ errorMsg: string, error?: ... }` — NOT a
// real `Error` instance — so `err instanceof Error` was false and
// `String(err)` on that plain object produced the literal text
// "[object Object]" instead of the actual error message.
export function extractErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === "string") return err || fallback;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    // Daily.co's DailyCallErrorObject shape.
    if (typeof obj.errorMsg === "string" && obj.errorMsg) return obj.errorMsg;
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (typeof obj.error === "string" && obj.error) return obj.error;
    if (obj.error && typeof obj.error === "object") {
      const nested = obj.error as Record<string, unknown>;
      if (typeof nested.message === "string" && nested.message) return nested.message;
    }
    // Last resort: don't ever hand back "[object Object]".
    try {
      const json = JSON.stringify(obj);
      if (json && json !== "{}") return json.slice(0, 200);
    } catch { /* circular or non-serializable */ }
  }
  return fallback;
}
