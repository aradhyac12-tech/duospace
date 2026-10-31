/**
 * Real Postgres RLS (PGlite) against the ACTUAL media_assets migration.
 * Production tables the migration alters (messages/gallery_items/memories) are stubbed with just the
 * columns/policies it depends on (gallery_items mirrors the production SELECT policy).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser, readMigration } from "./pgliteHarness";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;

async function seedAsset(n: number, owner: string, scope: string, extra = "") {
  await db.exec(`INSERT INTO public.media_assets (id,user_id,scope,media_type,resource_type,cloudinary_public_id ${extra ? "," + extra.split("=")[0] : ""})
    VALUES ('${id(n)}','${owner}','${scope}','image','image','duospace/users/${owner}/${scope}/${id(n)}' ${extra ? "," + extra.split("=")[1] : ""})`);
}
const visibleTo = (u: string) => asUser(db, u, async () => (await db.query<{ id: string }>(`SELECT id FROM public.media_assets ORDER BY id`)).rows.map((r) => r.id));

beforeEach(async () => {
  db = await makeDb(["20260910140000_lock_get_partner_id_to_self.sql"]);
  await db.exec(`
    INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}');
    INSERT INTO public.profiles (user_id, partner_id) VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);
    CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid, receiver_id uuid, file_url text);
    CREATE TABLE public.gallery_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, file_url text NOT NULL DEFAULT '', is_shared boolean NOT NULL DEFAULT false);
    CREATE TABLE public.memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), creator_id uuid NOT NULL, image_url text);
    ALTER TABLE public.gallery_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY gi_sel ON public.gallery_items FOR SELECT TO authenticated USING (auth.uid() = owner_id OR (is_shared = true AND owner_id = public.get_partner_id(auth.uid())));
    CREATE POLICY gi_ins ON public.gallery_items FOR INSERT TO authenticated WITH CHECK (auth.uid() = owner_id);
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages, public.gallery_items, public.memories TO authenticated;
  `);
  await db.exec(readMigration("20261004100000_cloudinary_media_assets.sql"));
}, 30_000);

describe("media_assets RLS", () => {
  it("owner reads own media", async () => { await seedAsset(1, A, "chat"); expect(await visibleTo(A)).toEqual([id(1)]); });

  it("linked partner reads chat / profile / memories media", async () => {
    await seedAsset(1, A, "chat"); await seedAsset(2, A, "profile"); await seedAsset(3, A, "memories");
    expect(await visibleTo(B)).toEqual([id(1), id(2), id(3)]);
  });

  it("partner CANNOT read an unshared gallery photo's metadata, CAN once it is shared", async () => {
    await seedAsset(1, A, "gallery");
    await db.exec(`INSERT INTO public.gallery_items (owner_id, file_url, is_shared, media_asset_id) VALUES ('${A}','media:${id(1)}',false,'${id(1)}')`);
    expect(await visibleTo(B)).toEqual([]);
    await db.exec(`UPDATE public.gallery_items SET is_shared = true`);
    expect(await visibleTo(B)).toEqual([id(1)]);
  });

  it("an unrelated user sees nothing, ever", async () => {
    await seedAsset(1, A, "chat"); await seedAsset(2, B, "profile"); await seedAsset(3, A, "gallery");
    expect(await visibleTo(C)).toEqual([]);
  });

  it("an unlinked user cannot see a former partner's media (relationship comes only from profiles.partner_id)", async () => {
    await seedAsset(1, A, "chat");
    await db.exec(`UPDATE public.profiles SET partner_id = NULL`);
    expect(await visibleTo(B)).toEqual([]);
  });

  it("soft-deleted media is invisible to everyone, including the owner", async () => {
    await seedAsset(1, A, "chat");
    await db.exec(`UPDATE public.media_assets SET status='deleted', deleted_at=now()`);
    expect(await visibleTo(A)).toEqual([]); expect(await visibleTo(B)).toEqual([]);
  });

  it("clients cannot insert, update or delete media_assets (no grant, no policy)", async () => {
    await seedAsset(1, B, "chat");
    const attempt = (sql: string) => asUser(db, A, () => db.query(sql)).then(() => "allowed", (e: Error) => e.message);
    expect(await attempt(`INSERT INTO public.media_assets (user_id,scope,media_type,resource_type,cloudinary_public_id) VALUES ('${A}','chat','image','image','x')`)).toMatch(/permission denied/i);
    expect(await attempt(`INSERT INTO public.media_assets (user_id,scope,media_type,resource_type,cloudinary_public_id) VALUES ('${B}','chat','image','image','y')`)).toMatch(/permission denied/i);
    expect(await attempt(`UPDATE public.media_assets SET user_id='${A}'`)).toMatch(/permission denied/i);
    expect(await attempt(`DELETE FROM public.media_assets`)).toMatch(/permission denied/i);
    expect((await db.query(`SELECT user_id FROM public.media_assets`)).rows).toEqual([{ user_id: B }]);
  });

  it("upload intents are not readable or writable by clients", async () => {
    const r = await asUser(db, A, () => db.query(`SELECT * FROM public.media_upload_intents`)).then(() => "allowed", (e: Error) => e.message);
    expect(r).toMatch(/permission denied/i);
  });

  it("public_id is unique and delivery_type can only be 'authenticated'", async () => {
    await seedAsset(1, A, "chat");
    await expect(seedAsset(2, A, "chat", `cloudinary_public_id=duospace/users/${A}/chat/${id(1)}`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO public.media_assets (user_id,scope,media_type,resource_type,delivery_type,cloudinary_public_id) VALUES ('${A}','chat','image','image','upload','z')`)).rejects.toThrow();
  });
});

describe("media_asset_id reference integrity", () => {
  it("a row can reference its OWN author's active media", async () => {
    await seedAsset(1, A, "gallery");
    await asUser(db, A, () => db.query(`INSERT INTO public.gallery_items (owner_id,file_url,media_asset_id) VALUES ($1,$2,$3)`, [A, `media:${id(1)}`, id(1)]));
    expect((await db.query(`SELECT 1 FROM public.gallery_items`)).rows).toHaveLength(1);
  });
  it("cannot reference someone else's media (forging ownership)", async () => {
    await seedAsset(1, B, "gallery");
    await expect(asUser(db, A, () => db.query(`INSERT INTO public.gallery_items (owner_id,file_url,media_asset_id) VALUES ($1,'x',$2)`, [A, id(1)]))).rejects.toThrow(/owned by the author/);
    await seedAsset(2, B, "chat");
    await expect(db.exec(`INSERT INTO public.messages (sender_id,receiver_id,media_asset_id) VALUES ('${A}','${B}','${id(2)}')`)).rejects.toThrow(/owned by the author/);
  });
  it("cannot reference a soft-deleted asset", async () => {
    await seedAsset(1, A, "memories");
    await db.exec(`UPDATE public.media_assets SET status='deleted', deleted_at=now()`);
    await expect(db.exec(`INSERT INTO public.memories (creator_id,media_asset_id) VALUES ('${A}','${id(1)}')`)).rejects.toThrow();
  });
  it("legacy rows with NULL media_asset_id are unaffected", async () => {
    await db.exec(`INSERT INTO public.messages (sender_id,receiver_id,file_url) VALUES ('${A}','${B}','https://legacy')`);
    expect((await db.query(`SELECT file_url FROM public.messages`)).rows).toEqual([{ file_url: "https://legacy" }]);
  });
  it("deleting a media_assets row leaves referencing rows intact (FK SET NULL)", async () => {
    await seedAsset(1, A, "chat");
    await db.exec(`INSERT INTO public.messages (sender_id,receiver_id,media_asset_id) VALUES ('${A}','${B}','${id(1)}')`);
    await db.exec(`DELETE FROM public.media_assets`);
    expect((await db.query(`SELECT media_asset_id FROM public.messages`)).rows).toEqual([{ media_asset_id: null }]);
  });
});
