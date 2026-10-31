// @vitest-environment node
// Real tests of the pure server-side logic the edge functions use. Signatures are cross-checked
// against an independent node:crypto computation (same algorithm as Cloudinary's documented one).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  adaptVariant, buildSignedDeliveryUrl, buildUploadAuthorization, deliverySignature, DEFAULT_LIMITS, isVariantName,
  parsePublicId, publicIdFor, signApiParams, validateSignRequest, validateStoredResource, VARIANTS,
} from "../../supabase/functions/_shared/cloudinaryCore";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", M = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "test-secret-not-real";
const sha1hex = (s: string) => createHash("sha1").update(s).digest("hex");

describe("validateSignRequest", () => {
  const ok = { scope: "gallery", mime_type: "image/jpeg", bytes: 1000 };
  it("accepts a valid image", () => expect(validateSignRequest(ok).ok).toBe(true));
  it("rejects unknown scope (client cannot pick a folder)", () => expect(validateSignRequest({ ...ok, scope: "../../etc" })).toMatchObject({ ok: false, code: "INVALID_SCOPE" }));
  it("rejects unsupported MIME", () => expect(validateSignRequest({ ...ok, mime_type: "application/pdf" })).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" }));
  it("rejects oversized image and video using their own limits", () => {
    expect(validateSignRequest({ ...ok, bytes: DEFAULT_LIMITS.maxImageBytes + 1 })).toMatchObject({ ok: false, code: "TOO_LARGE" });
    expect(validateSignRequest({ scope: "gallery", mime_type: "video/mp4", bytes: DEFAULT_LIMITS.maxImageBytes + 1 }).ok).toBe(true);
    expect(validateSignRequest({ scope: "gallery", mime_type: "video/mp4", bytes: DEFAULT_LIMITS.maxVideoBytes + 1 })).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });
  it("rejects zero/negative/NaN sizes", () => { for (const bytes of [0, -5, "abc", undefined]) expect(validateSignRequest({ ...ok, bytes }).ok).toBe(false); });
  it("keeps profile and memories image-only", () => {
    expect(validateSignRequest({ scope: "profile", mime_type: "video/mp4", bytes: 10 }).ok).toBe(false);
    expect(validateSignRequest({ scope: "memories", mime_type: "video/mp4", bytes: 10 }).ok).toBe(false);
  });
  it("rejects a resource_type that contradicts the MIME", () => expect(validateSignRequest({ ...ok, resource_type: "video" })).toMatchObject({ ok: false, code: "TYPE_MISMATCH" }));
  it("requires client_upload_id to be a UUID", () => expect(validateSignRequest({ ...ok, client_upload_id: "../x" }).ok).toBe(false));
  it("sanitises filenames", () => {
    const r = validateSignRequest({ ...ok, original_filename: "a/b\\c\u0000.jpg" });
    expect(r.ok && r.value.filename).toBe("abc.jpg");
  });
});

describe("folder / public id", () => {
  it("is UUID-only and round-trips", () => {
    const id = publicIdFor(U, "chat", M);
    expect(id).toBe(`duospace/users/${U}/chat/${M}`);
    expect(parsePublicId(id)).toEqual({ userId: U, scope: "chat", mediaId: M });
  });
  it("rejects names, traversal and foreign shapes", () => {
    for (const bad of ["duospace/users/alice@x.com/chat/" + M, `duospace/users/${U}/secret/${M}`, `other/users/${U}/chat/${M}`, `duospace/users/${U}/chat/${M}/extra`]) expect(parsePublicId(bad)).toBeNull();
  });
});

describe("signatures", () => {
  it("API signature = sha1(sorted k=v&... + secret), ignoring file/api_key/resource_type", async () => {
    const sig = await signApiParams({ timestamp: 1700000000, public_id: "p", type: "authenticated", api_key: "k", resource_type: "image" }, SECRET);
    expect(sig).toBe(sha1hex(`public_id=p&timestamp=1700000000&type=authenticated${SECRET}`));
  });
  it("upload authorization signs the server-chosen public_id and type=authenticated, and never contains the secret", async () => {
    const a = await buildUploadAuthorization({ cloudName: "demo", apiKey: "123", apiSecret: SECRET }, { publicId: publicIdFor(U, "gallery", M), resourceType: "video", nowSeconds: 1700000000 });
    expect(a.type).toBe("authenticated");
    expect(a.uploadUrl).toBe("https://api.cloudinary.com/v1_1/demo/video/upload");
    expect(a.signature).toBe(sha1hex(`public_id=${publicIdFor(U, "gallery", M)}&timestamp=1700000000&type=authenticated${SECRET}`));
    expect(JSON.stringify(a)).not.toContain(SECRET);
  });
  it("delivery signature = first 8 chars of url-safe base64(sha1(to_sign+secret))", async () => {
    const expected = createHash("sha1").update("c_fill,w_100/sample.jpg" + SECRET).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 8);
    expect(await deliverySignature("c_fill,w_100/sample.jpg", SECRET)).toBe(expected);
    expect(expected).toHaveLength(8);
  });
});

describe("variants and delivery URLs", () => {
  const pid = publicIdFor(U, "gallery", M);
  it("builds an authenticated, signed image URL (never the public /upload/ path)", async () => {
    const url = await buildSignedDeliveryUrl({ cloudName: "demo", apiSecret: SECRET }, { publicId: pid, resourceType: "image", variant: "GALLERY_PREVIEW" });
    expect(url).toMatch(/^https:\/\/res\.cloudinary\.com\/demo\/image\/authenticated\/s--[A-Za-z0-9_-]{8}--\//);
    expect(url).not.toContain("/upload/");
    expect(url).toContain(VARIANTS.GALLERY_PREVIEW.transformation);
    expect(url.endsWith(pid)).toBe(true);
    expect(url).not.toContain(SECRET);
  });
  it("uses a jpg extension (and signs it) for video posters", async () => {
    const url = await buildSignedDeliveryUrl({ cloudName: "demo", apiSecret: SECRET }, { publicId: pid, resourceType: "video", variant: "VIDEO_POSTER" });
    expect(url).toContain("/video/authenticated/");
    expect(url.endsWith(`${pid}.jpg`)).toBe(true);
    const sig = /s--([^-]+(?:-[^-]+)*)--/.exec(url)![1];
    expect(sig).toBe(await deliverySignature(`${VARIANTS.VIDEO_POSTER.transformation}/${pid}.jpg`, SECRET));
  });
  it("different variants/public ids give different signatures (a URL cannot be re-targeted)", async () => {
    const cfg = { cloudName: "demo", apiSecret: SECRET };
    const a = await buildSignedDeliveryUrl(cfg, { publicId: pid, resourceType: "image", variant: "AVATAR" });
    const b = await buildSignedDeliveryUrl(cfg, { publicId: pid, resourceType: "image", variant: "FULLSCREEN" });
    const c = await buildSignedDeliveryUrl(cfg, { publicId: publicIdFor(U, "gallery", U), resourceType: "image", variant: "AVATAR" });
    const sigOf = (u: string) => /s--(.+?)--/.exec(u)![1];
    expect(new Set([sigOf(a), sigOf(b), sigOf(c)]).size).toBe(3);
  });
  it("only whitelisted variant names exist; unknown ones are not signable", () => {
    expect(isVariantName("AVATAR")).toBe(true);
    expect(isVariantName("w_99999")).toBe(false);
    expect(isVariantName("constructor")).toBe(false);
  });
  it("adapts image variants to the stream variant for videos but never the reverse", async () => {
    expect(adaptVariant("CHAT_THUMBNAIL", "video")).toBe("VIDEO_STREAM");
    expect(adaptVariant("VIDEO_POSTER", "video")).toBe("VIDEO_POSTER");
    expect(adaptVariant("VIDEO_STREAM", "image")).toBe("VIDEO_STREAM"); // stays a video variant -> mismatch -> rejected
    await expect(buildSignedDeliveryUrl({ cloudName: "d", apiSecret: SECRET }, { publicId: pid, resourceType: "image", variant: "VIDEO_STREAM" })).rejects.toThrow("VARIANT_RESOURCE_MISMATCH");
  });
});

describe("validateStoredResource (what Cloudinary really stored)", () => {
  const intent = { cloudinary_public_id: publicIdFor(U, "gallery", M), resource_type: "image" as const, max_bytes: 1000 };
  const good = { public_id: intent.cloudinary_public_id, type: "authenticated", resource_type: "image", bytes: 500, width: 100, height: 100 };
  it("accepts a matching authenticated asset", () => expect(validateStoredResource(good, intent).ok).toBe(true));
  it("rejects a different public_id", () => expect(validateStoredResource({ ...good, public_id: "x" }, intent)).toMatchObject({ code: "PUBLIC_ID_MISMATCH" }));
  it("rejects a PUBLIC (type=upload) asset", () => expect(validateStoredResource({ ...good, type: "upload" }, intent)).toMatchObject({ code: "NOT_AUTHENTICATED" }));
  it("rejects wrong resource type, oversize, huge dimensions", () => {
    expect(validateStoredResource({ ...good, resource_type: "video" }, intent)).toMatchObject({ code: "TYPE_MISMATCH" });
    expect(validateStoredResource({ ...good, bytes: 5000 }, intent)).toMatchObject({ code: "TOO_LARGE" });
    expect(validateStoredResource({ ...good, width: 99999 }, intent)).toMatchObject({ code: "TOO_LARGE" });
  });
  it("rejects over-long videos", () => {
    const vi = { ...intent, resource_type: "video" as const };
    expect(validateStoredResource({ ...good, resource_type: "video", duration: 9999 }, vi)).toMatchObject({ code: "TOO_LONG" });
    expect(validateStoredResource({ ...good, resource_type: "video", duration: 30 }, vi).ok).toBe(true);
  });
});
