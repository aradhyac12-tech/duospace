# Dead Code / Dependency Cleanup — Phase 8L

Done last, after functional/security fixes, per the task's own ordering.

## Light pass performed

- Searched for leftover Google Drive backup code following the
  `20260721111940_drop_orphaned_gdrive_backup.sql` migration (which dropped
  the old GDrive-based backup approach in favor of the current
  `useCloudBackup` Lovable Cloud Storage flow). **Result: clean** — no
  `gdrive`/`google drive` references remain anywhere in `src/`.
- Searched for files named with common dead-code markers
  (`*legacy*`, `*deprecated*`, `*_old*`, `*.bak`). **Result: none found.**
- Confirmed `useCloudBackup` (the hook touched heavily this session) has
  exactly one consumer, `BackupManager.tsx`, as expected — not orphaned.

## Not performed — needs tooling this sandbox doesn't have

A full unused-dependency sweep (comparing every `package.json` dependency
against actual imports across `src/`, native build scripts, Vite/Tailwind
configs, and test setup) really needs a tool like `knip` or `depcheck` run
against an installed `node_modules` to be trustworthy — grepping 60+ package
names by hand risks exactly the false-positive the task warned against
("do not remove a dependency merely because it isn't imported from src/ if
it is used by Vite/Tailwind/scripts/native build/test setup"). Since `npm
ci` cannot run in this sandbox (no network), this wasn't attempted beyond
the two spot-checks above — flagged as a follow-up for an environment with
registry access, not left silently undone.

## Status: **STATICALLY VERIFIED** (light pass only) — full dependency graph
analysis **REQUIRES AN ENVIRONMENT WITH `npm ci` ACCESS**.
