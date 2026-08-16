# Supabase Project Configuration

## Canonical production project

**`jzlpelxwzjjpddqcrtpu`**

Confirmed consistent across every source in this repo:

| Source | Value |
|---|---|
| `supabase/config.toml` | `project_id = "jzlpelxwzjjpddqcrtpu"` |
| `src/integrations/supabase/client.ts` | fallback URL `https://jzlpelxwzjjpddqcrtpu.supabase.co` |
| `.env.example` | `VITE_SUPABASE_URL=https://jzlpelxwzjjpddqcrtpu.supabase.co` |
| `DEPLOY.md` | frontend env, auth callback URL, Edge Function deploy target |
| `supabase/config.toml` `[auth]` | `site_url = "https://web-duospace.lovable.app"` |

- **Frontend URL:** `https://web-duospace.lovable.app` (from `supabase/config.toml [auth] site_url`)
- **Edge Function URL:** `https://jzlpelxwzjjpddqcrtpu.supabase.co/functions/v1/<name>`
- **Storage URL:** `https://jzlpelxwzjjpddqcrtpu.supabase.co/storage/v1/object/...`
- **Auth URL:** `https://jzlpelxwzjjpddqcrtpu.supabase.co/auth/v1`
- **Realtime URL:** `wss://jzlpelxwzjjpddqcrtpu.supabase.co/realtime/v1`

(Storage/Auth/Realtime URLs are the standard Supabase per-project pattern
derived from the confirmed project ref — not independently hardcoded
anywhere in the repo, which is correct: the client SDK derives them.)

## Stale references found and removed

**`lotznohocfmwmyyexoxp`** did not exist anywhere in this snapshot prior to
this session (unlike a related snapshot reviewed earlier, where it was
found hardcoded in two cron job URLs and fixed). The scheduled-message cron
job added in this session (`20260811101000_...sql`) was written from the
start to resolve its target URL from Vault (`project_url` secret) rather
than a hardcoded literal, so there was nothing stale to introduce.

No other stale project refs, Edge Function URLs, storage URLs, or webhook
URLs were found in `supabase/`, `src/`, or the root-level docs
(`DEPLOY.md`, `SETUP_GUIDE.md`, `.env.example`) during this session's
searches.

One unrelated historical reference: `docs/phases.md` mentions a *previous*
project ref (`ffrsohhfqcypnkkbtali`) in a past-tense narrative about
migrating to the current project — this is documentation of history, not a
live reference, and doesn't need changing.

## References requiring live Dashboard verification

None of the following can be confirmed from source — they're standard
per-project settings that only exist in the live Supabase Dashboard:

- That `jzlpelxwzjjpddqcrtpu` is actually the project currently receiving
  production traffic (this doc only confirms internal *consistency*, not
  that the live deployment matches).
- Vault secrets `project_url` and `service_role_key` actually exist in that
  project (required by every cron job added across this repo's history —
  `deliver-scheduled-messages`, `cleanup-orphan-uploads`'s pre-existing
  broken auth, `fcm_push_notifications`, `ios_voip_push`).
- `pg_cron` and `pg_net` extensions are enabled.
- Auth redirect URLs configured in the Dashboard actually match
  `supabase/config.toml`'s `additional_redirect_urls` list.
- Edge Functions listed under `supabase/functions/` are actually deployed
  (a function existing in the repo doesn't mean `supabase functions deploy`
  has been run against production — see Section 19 audit).

No secret values are printed anywhere in this document.
