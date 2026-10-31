// Shared plumbing for the Cloudinary media edge functions: CORS, JSON replies,
// caller authentication, limits from env. No secrets are logged or returned.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "./cors.ts";
import { DEFAULT_LIMITS, type MediaLimits } from "./cloudinaryCore.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

export const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export function limitsFromEnv(): MediaLimits {
  const n = (k: string, d: number) => { const v = Number(Deno.env.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    maxImageBytes: n("MEDIA_MAX_IMAGE_BYTES", DEFAULT_LIMITS.maxImageBytes),
    maxVideoBytes: n("MEDIA_MAX_VIDEO_BYTES", DEFAULT_LIMITS.maxVideoBytes),
    maxVideoSeconds: n("MEDIA_MAX_VIDEO_SECONDS", DEFAULT_LIMITS.maxVideoSeconds),
    maxDimension: n("MEDIA_MAX_DIMENSION", DEFAULT_LIMITS.maxDimension),
  };
}

export interface Caller { userId: string; jwt: string; /** Client acting AS the user: RLS applies. */ asUser: SupabaseClient }

/** Verifies the bearer JWT with Supabase Auth. Returns null when missing/invalid/expired. */
export async function authenticate(req: Request): Promise<Caller | null> {
  const jwt = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user?.id) return null;
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
  });
  return { userId: data.user.id, jwt, asUser };
}

/** Structured, secret-free log line. */
export const logOp = (fn: string, op: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ fn, op, ...extra }));
