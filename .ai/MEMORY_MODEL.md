# Relationship Memory Model (canonical, Phase 3D as audited + Phase 3E hardening)

Local, encrypted (see PRIVACY_MODEL), user-created only. Records: provenance, evidence level 1–5, temporal states CURRENT / MAY_BE_OUTDATED (180 d) / HISTORICAL / WITHDRAWN / EXPIRED; retention 90 / 365 d / none by category. Sharing: one record at a time via `relationship_shares` (MEMORY / AGREEMENT / AGREEMENT_RESPONSE), server-validated shape (migration 20260925210000), multilingual safety gate before share.

Consistency model (NOT a distributed transaction):
- Change a shared memory → withdraw share first → then change locally; if withdraw fails nothing changes.
- Delete-all / consent-off → strict list (fails if offline) → withdraw each (idempotent revoke) → strict re-list must be empty → only then delete locally.
- On load, local SHARED flags are reconciled against the owner's live server rows (fixes unlink auto-revoke and partial failures); never reconciled from a failed list.
- All UI writes go through one serialized queue that starts from the latest state (no lost updates within a device).
- Memory is per device; there is no cross-device sync of private memory, so "two devices editing the same memory" cannot conflict (each device has its own store). Shared rows are server-authoritative.
Known limits: a share completing after the verify step of a consent withdrawal is undone by the post-share consent re-check; duplicate share clicks are blocked by the server's unique active-item index (second click shows an error).
