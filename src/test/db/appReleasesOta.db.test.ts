/**
 * Runs the ACTUAL 20261003190000_app_releases_ota.sql on real Postgres (PGlite)
 * and proves the access rules the feature depends on:
 *   - only the ADMIN can create / publish / unpublish / delete releases
 *   - a FOUNDER (a "premium" account) is NOT an admin here
 *   - the storage bucket policies are admin-only and pin the object name
 *   - signed-out callers can learn a published release exists, but get no path
 *   - mandatory flags aggregate across skipped versions
 *   - every admin action is audited
 * Storage and the admin-console gate are the only stubs: `storage.*` (absent in
 * the harness) and private.assert_admin()/admin_log(), which are sliced
 * verbatim out of 20261003100000_admin_console.sql so the real gate is tested.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser, readMigration } from "./pgliteHarness";

const ADMIN = "10000000-0000-4000-8000-000000000001";
const ALICE = "10000000-0000-4000-8000-000000000002"; // plain user
const FOUNDER = "10000000-0000-4000-8000-000000000003"; // premium, but not admin
const SHA = "a".repeat(64);

let db: PGlite;

function adminGateSql(): string {
  const src = readMigration("20261003100000_admin_console.sql");
  const from = src.indexOf("CREATE OR REPLACE FUNCTION private.assert_admin()");
  const to = src.indexOf("-- 1. Moderation (block / unblock)");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to).replace(/-- -+\s*$/, "");
}

beforeAll(async () => {
  db = await makeDb([
    "20260910140000_lock_get_partner_id_to_self.sql",
    "20260922100000_relationship_shares.sql",
    "20260926120000_monetization_entitlements_foundation.sql",
    "20260927090000_monetization_admin_grant_rpc.sql",
    "20260927091500_monetization_fix_admin_search_plan_lookup.sql",
    "20260927093000_monetization_protect_self_bootstrap_admin_grant.sql",
    "20260927130000_monetization_lifecycle_hardening.sql",
  ]);
  await db.exec(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
    INSERT INTO auth.users(id) VALUES ('${ADMIN}'),('${ALICE}'),('${FOUNDER}');
    INSERT INTO public.profiles(user_id, partner_id) VALUES ('${ADMIN}',NULL),('${ALICE}',NULL),('${FOUNDER}',NULL);
    INSERT INTO public.entitlements(user_id, plan, status, source, granted_by)
      VALUES ('${ADMIN}', 'ADMIN', 'active', 'admin_grant', '${ADMIN}'),
             ('${FOUNDER}', 'FOUNDER', 'active', 'admin_grant', '${ADMIN}');

    -- Supabase storage stand-in (the harness has no storage schema).
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint);
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO authenticated, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
    GRANT SELECT ON storage.buckets TO authenticated;
  `);
  await db.exec(adminGateSql());
  // Mirror Supabase: new public tables get ALL for authenticated by default.
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon;`);
  await db.exec(readMigration("20261003190000_app_releases_ota.sql"));
  await db.exec(readMigration("20261003191000_app_releases_revoke_default_grants.sql"));
}, 60_000);

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}
const asAnon = async <T,>(fn: () => Promise<T>): Promise<T> => {
  await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claim.sub', '', false);`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE;`); }
};

const putObject = (uid: string, name: string, size = 1234) =>
  asUser(db, uid, () => db.query(
    `INSERT INTO storage.objects(bucket_id, name, owner, metadata) VALUES ('app-releases', $1, $2, $3::jsonb)`,
    [name, uid, JSON.stringify({ size })]));

const createRelease = (uid: string, v: { name: string; code: number; publish?: boolean; mandatory?: boolean; platform?: string; path?: string | null }) =>
  asUser(db, uid, () => db.query(
    `SELECT public.admin_create_app_release($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [v.platform ?? "android", v.name, v.code, "notes", v.mandatory ?? false,
     v.path === undefined ? `${v.platform ?? "android"}/${v.code}/duospace-${v.name}.apk` : v.path,
     SHA, null, v.publish ?? true]));

describe("who may manage releases", () => {
  it("a plain user and even a FOUNDER cannot create a release", async () => {
    for (const uid of [ALICE, FOUNDER]) {
      expect(await denied(() => createRelease(uid, { name: "9.0.0", code: 90000 })), uid).toBe(true);
    }
  });

  it("a non-admin cannot write the table directly or read it", async () => {
    expect(await denied(() => asUser(db, FOUNDER, () => db.query(
      `INSERT INTO public.app_releases(platform,version_name,version_code,file_path,file_size_bytes,sha256,created_by)
       VALUES ('android','9.0.0',90000,'android/90000/x.apk',1,'${SHA}','${FOUNDER}')`)))).toBe(true);
    const rows = await asUser(db, FOUNDER, async () => (await db.query(`SELECT * FROM public.app_releases`)).rows);
    expect(rows).toHaveLength(0);
  });

  it("even with Supabase-style default grants, authenticated can only SELECT (no TRUNCATE)", async () => {
    const privs = (await db.query<{ p: string }>(
      `SELECT privilege_type AS p FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name='app_releases' AND grantee='authenticated'`)).rows.map((r) => r.p);
    expect(privs).toEqual(["SELECT"]);
    expect(await denied(() => asUser(db, FOUNDER, () => db.query(`TRUNCATE public.app_releases`)))).toBe(true);
  });

  it("anon has no table access at all", async () => {
    expect(await denied(() => asAnon(() => db.query(`SELECT * FROM public.app_releases`)))).toBe(true);
    expect(await denied(() => asAnon(() => db.query(`SELECT public.admin_create_app_release('android','1.0.0',10000,'',false,null,null,null,false)`)))).toBe(true);
  });

  it("is_app_admin is true only for the ADMIN account", async () => {
    const check = (uid: string) => asUser(db, uid, async () => (await db.query<{ v: boolean }>(`SELECT public.is_app_admin() AS v`)).rows[0].v);
    expect(await check(ADMIN)).toBe(true);
    expect(await check(FOUNDER)).toBe(false);
    expect(await check(ALICE)).toBe(false);
  });
});

describe("storage bucket", () => {
  it("is private", async () => {
    const r = await db.query<{ public: boolean }>(`SELECT public FROM storage.buckets WHERE id='app-releases'`);
    expect(r.rows[0].public).toBe(false);
  });

  it("only the admin can upload, and only with a well-formed name", async () => {
    expect(await denied(() => putObject(FOUNDER, "android/32200/duospace-3.22.0.apk"))).toBe(true);
    expect(await denied(() => putObject(ALICE, "android/32200/duospace-3.22.0.apk"))).toBe(true);
    expect(await denied(() => putObject(ADMIN, "../evil.apk"))).toBe(true);
    expect(await denied(() => putObject(ADMIN, "android/32200/payload.exe"))).toBe(true);
    expect(await denied(() => putObject(ADMIN, "android/abc/x.apk"))).toBe(true);
    expect(await denied(() => putObject(ADMIN, "android/32200/duospace-3.22.0.apk"))).toBe(false);
  });

  it("a non-admin cannot see or delete the uploaded object", async () => {
    const seen = await asUser(db, FOUNDER, async () => (await db.query(`SELECT name FROM storage.objects WHERE bucket_id='app-releases'`)).rows);
    expect(seen).toHaveLength(0);
    const del = await asUser(db, FOUNDER, () => db.query(`DELETE FROM storage.objects WHERE bucket_id='app-releases'`));
    expect(del.affectedRows ?? 0).toBe(0);
  });
});

describe("release lifecycle (as the admin)", () => {
  it("rejects a release whose file was never uploaded, a bad path, and a wrong extension", async () => {
    expect(await denied(() => createRelease(ADMIN, { name: "3.22.1", code: 32201 }))).toBe(true); // no object
    await putObject(ADMIN, "android/32201/duospace-3.22.1.apk");
    expect(await denied(() => createRelease(ADMIN, { name: "3.22.1", code: 32201, path: "android/99999/duospace.apk" }))).toBe(true);
    expect(await denied(() => createRelease(ADMIN, { name: "3.22.1", code: 32201, path: "android/32201/duospace-3.22.1.ipa" }))).toBe(true);
    expect(await denied(() => createRelease(ADMIN, { name: "3.22", code: 32201 }))).toBe(true); // not x.y.z
  });

  it("creates, takes the size from storage (not the client), and the first row is published", async () => {
    // 3.22.0 object was uploaded above with size 1234
    await createRelease(ADMIN, { name: "3.22.0", code: 32200 });
    const row = (await db.query<{ file_size_bytes: string; status: string; published_at: string | null }>(
      `SELECT file_size_bytes::text, status, published_at::text FROM public.app_releases WHERE version_code=32200`)).rows[0];
    expect(row.file_size_bytes).toBe("1234");
    expect(row.status).toBe("published");
    expect(row.published_at).not.toBeNull();
  });

  it("refuses a duplicate platform+build", async () => {
    expect(await denied(() => createRelease(ADMIN, { name: "3.22.0", code: 32200 }))).toBe(true);
  });

  it("signed-out callers get metadata for a newer release, never the storage path", async () => {
    const r = await asAnon(async () => (await db.query<{ r: Record<string, unknown> | null }>(
      `SELECT public.get_latest_app_release('android', 32101) AS r`)).rows[0].r);
    expect(r).not.toBeNull();
    expect(r!.version_name).toBe("3.22.0");
    expect(r!.has_file).toBe(true);
    expect(r!.sha256).toBe(SHA);
    expect(Object.keys(r!)).not.toContain("file_path");
    expect(JSON.stringify(r)).not.toContain("duospace-3.22.0.apk");
  });

  it("returns nothing when already current, for another platform, or for junk input", async () => {
    const get = (p: string, c: number | null) => asAnon(async () => (await db.query<{ r: unknown }>(
      `SELECT public.get_latest_app_release($1, $2) AS r`, [p, c])).rows[0].r);
    expect(await get("android", 32200)).toBeNull();
    expect(await get("android", 99999)).toBeNull();
    expect(await get("ios", 1)).toBeNull();
    expect(await get("windows", 1)).toBeNull();
  });

  it("a draft is invisible to the public until published, and unpublishing hides it again", async () => {
    await putObject(ADMIN, "android/32300/duospace-3.23.0.apk");
    await createRelease(ADMIN, { name: "3.23.0", code: 32300, publish: false });
    const get = () => asAnon(async () => (await db.query<{ r: { version_name: string } | null }>(
      `SELECT public.get_latest_app_release('android', 32200) AS r`)).rows[0].r);
    expect(await get()).toBeNull();

    const id = (await db.query<{ id: string }>(`SELECT id FROM public.app_releases WHERE version_code=32300`)).rows[0].id;
    expect(await denied(() => asUser(db, FOUNDER, () => db.query(`SELECT public.admin_set_app_release_status($1,'published')`, [id])))).toBe(true);
    await asUser(db, ADMIN, () => db.query(`SELECT public.admin_set_app_release_status($1,'published')`, [id]));
    expect((await get())!.version_name).toBe("3.23.0");
    await asUser(db, ADMIN, () => db.query(`SELECT public.admin_set_app_release_status($1,'revoked')`, [id]));
    expect(await get()).toBeNull();
  });

  it("a mandatory release can't be skipped by jumping past it", async () => {
    await putObject(ADMIN, "android/32400/duospace-3.24.0.apk");
    await putObject(ADMIN, "android/32500/duospace-3.25.0.apk");
    await createRelease(ADMIN, { name: "3.24.0", code: 32400, mandatory: true });
    await createRelease(ADMIN, { name: "3.25.0", code: 32500, mandatory: false });
    const r = await asAnon(async () => (await db.query<{ r: { version_name: string; mandatory: boolean } }>(
      `SELECT public.get_latest_app_release('android', 32200) AS r`)).rows[0].r);
    expect(r.version_name).toBe("3.25.0");
    expect(r.mandatory).toBe(true); // 3.24.0 sits between and is mandatory
    const newer = await asAnon(async () => (await db.query<{ r: { mandatory: boolean } }>(
      `SELECT public.get_latest_app_release('android', 32400) AS r`)).rows[0].r);
    expect(newer.mandatory).toBe(false);
  });

  it("a published release cannot be deleted; an unpublished one can; non-admins can't", async () => {
    const id = (await db.query<{ id: string }>(`SELECT id FROM public.app_releases WHERE version_code=32500`)).rows[0].id;
    expect(await denied(() => asUser(db, ADMIN, () => db.query(`SELECT public.admin_delete_app_release($1)`, [id])))).toBe(true);
    await asUser(db, ADMIN, () => db.query(`SELECT public.admin_set_app_release_status($1,'revoked')`, [id]));
    expect(await denied(() => asUser(db, FOUNDER, () => db.query(`SELECT public.admin_delete_app_release($1)`, [id])))).toBe(true);
    await asUser(db, ADMIN, () => db.query(`SELECT public.admin_delete_app_release($1)`, [id]));
    expect((await db.query(`SELECT 1 FROM public.app_releases WHERE id=$1`, [id])).rows).toHaveLength(0);
  });

  it("an iOS store-link release needs no file; an Android one without a file is rejected", async () => {
    await asUser(db, ADMIN, () => db.query(
      `SELECT public.admin_create_app_release('ios','3.22.0',32200,'n',false,NULL,NULL,'https://apps.apple.com/app/id1',true)`));
    const r = await asAnon(async () => (await db.query<{ r: { external_url: string; has_file: boolean } }>(
      `SELECT public.get_latest_app_release('ios', 1) AS r`)).rows[0].r);
    expect(r.external_url).toBe("https://apps.apple.com/app/id1");
    expect(r.has_file).toBe(false);
    expect(await denied(() => asUser(db, ADMIN, () => db.query(
      `SELECT public.admin_create_app_release('android','3.26.0',32600,'',false,NULL,NULL,NULL,true)`)))).toBe(true);
    expect(await denied(() => asUser(db, ADMIN, () => db.query(
      `SELECT public.admin_create_app_release('ios','3.27.0',32700,'',false,NULL,NULL,'http://insecure.example',true)`)))).toBe(true);
  });

  it("every admin action is in the audit log", async () => {
    const rows = (await db.query<{ action: string }>(`SELECT action FROM public.admin_audit_log`)).rows.map((r) => r.action);
    expect(rows).toContain("create_app_release");
    expect(rows).toContain("set_app_release_status");
    expect(rows).toContain("delete_app_release");
  });
});
