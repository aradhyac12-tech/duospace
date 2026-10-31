
## Relationship sharing — evidence-backed claims (Phase 3F, 2026-09-26)
Verified on a real Supabase staging project (`otaficrlkiscaihdwxnt`) with three users, at the database level (real roles, RLS, triggers, constraints; identities via `request.jwt.claims`):
- Only the owner and the **current** partner can read a share; revoked/expired shares and shares from an ex-partner are invisible; strangers and `anon` see nothing.
- Shares can only be addressed to the current partner; owner cannot be forged; `partner_id` cannot be self-assigned; a second profile cannot be inserted.
- Share rows are immutable except for revocation; revocation is permanent and server-timestamped; fabricated created/revoked/expiry values are overwritten.
- Payload shapes (MEMORY/AGREEMENT/REPAIR_MESSAGE) are server-validated; the hidden-payload channel (D3) is closed, including on upgrade.
- Unlink revokes every share both ways in the same transaction; relink does not resurrect them; the SELECT policy independently re-checks the link.
- Privileged helpers (`revoke_relationship_shares_between`, `private.apply_unlink`) are not callable by `authenticated`/`anon`.
Not yet evidenced: HTTP-level auth/session behaviour, device behaviour, and **production** — the relationship_shares migrations are not deployed there.
Encryption at rest on device remains **PARTIAL** (software AES-256-GCM key in the app sandbox; not hardware-backed) — unchanged.
