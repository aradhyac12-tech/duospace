# Supabase Observability

## What's already good (found via source read, not assumed)

Every Edge Function reviewed uses a consistent `[function-name] context:
detail` `console.error` pattern with structured context (recipient/device
id, object path, HTTP status) rather than dumping entire request/response
bodies indiscriminately. Specific spot-checks for secret/content leakage:

- `daily-call`: logs Daily.co's *error* response bodies on failed API
  calls (`res.status, data`) — these are Daily's own error payloads
  (`{error, info}`), not meeting tokens (a token is never present in a
  failed token-issuance response), and the same object is already returned
  to the client in the response body, so server-side logging adds no new
  exposure.
- `deliver-scheduled-messages`, `finalize-upload`, `cleanup-orphan-uploads`:
  log message/object IDs and error reasons, never message `content` or file
  bytes.
- `send-push`/`send-voip-push`: log recipient/device IDs and delivery
  failure reasons, never the push payload's message content or the
  FCM/APNs credentials used to send it.
- No function logs a raw Authorization header, service-role key, or Vault
  secret value anywhere found this session.

## Gaps

- **No request-ID / correlation-ID pattern.** None of the 18 Edge
  Functions generate or propagate a request ID, so correlating a single
  user-facing failure across multiple log lines (or across an Edge
  Function → RPC → trigger chain) requires manually cross-referencing
  timestamps and user/object IDs instead of one ID. Not critical at
  current scale, but worth adding if debugging production incidents
  becomes a recurring pain point.
- **No structured/JSON logging** — everything is a `console.error(string,
  ...)` call, which Supabase's log viewer captures but doesn't let you
  query by field (e.g. "show me every failure for user X" requires a text
  search, not a filter).
- **pg_cron job failures are silent to anyone not actively checking
  `cron.job_run_details`.** All three cron jobs (`delete-expired-messages`,
  `cleanup-orphan-uploads`, `deliver-scheduled-messages`) either run
  in-process (no external alerting possible) or `RAISE WARNING`/`RAISE
  NOTICE` on failure, which lands in Postgres logs but not anywhere a human
  gets paged. `cleanup-orphan-uploads`'s likely-broken auth (see
  `SUPABASE_SCHEMA_INVENTORY.md`) is the concrete example of a job that has
  probably been silently failing since 2026-05-02 with nothing surfacing
  that fact anywhere a person would see it.
- **Database function exceptions** (`RAISE EXCEPTION` in `guard_message_update`,
  `accept_partner_request`, etc.) surface to the calling client via
  PostgREST's error response, which is fine for the client to react to, but
  there's no server-side aggregation of how often these fire — a spike in
  "Not allowed" exceptions from `unlink_partner`/`accept_invite` (which
  would indicate either an attempted IDOR exploit or a client bug sending
  the wrong user ID) would currently go unnoticed.

## Recommendations (not implemented this session — Section 21 scope is
documentation, not new infrastructure)

1. If Supabase's log drain / external log sink (Logflare, Datadog, etc.) is
   configured at the Dashboard level, route Edge Function and Postgres logs
   there and set an alert on `cron.job_run_details` failures — this is a
   Dashboard/external-service configuration, not a code change.
2. Consider a lightweight request-ID convention (`crypto.randomUUID()` at
   the top of each Edge Function, included in every log line and the error
   response) if production debugging starts requiring it.
3. Consider a scheduled health-check (could reuse the existing `pg_cron` +
   Vault pattern) that periodically confirms all three cron jobs actually
   ran recently, rather than relying on someone manually checking
   `cron.job_run_details`.

None of the above are P0/P1 — they're operability improvements, not
security or correctness fixes, which is why they're documented as
recommendations rather than implemented as migrations in this pass.
