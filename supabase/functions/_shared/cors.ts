// Shared CORS headers for edge functions.
// ALLOWED_ORIGIN should be set in env for production; falls back to "*" in dev.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
};

export function handleOptions(): Response {
  return new Response("ok", { headers: corsHeaders });
}
