import { supabase as generatedClient, isSupabaseConfigured } from "./client";

// The connected project's schema metadata is temporarily unavailable, so the
// generated Database type has no table keys and makes every `.from()` call
// infer `never`. Keep the generated client untouched and expose the same
// runtime client with an open schema type until metadata is restored.
export const supabase: any = generatedClient;

export { isSupabaseConfigured };