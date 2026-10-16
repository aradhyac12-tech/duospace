// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invoke, FakeEdgeErr, legacyResolve } = vi.hoisted(() => {
  class FakeEdgeErr extends Error {
    constructor(m: string, public cause: string, public requestId = "r", public status?: number, public debug?: string[], public responseBody?: unknown) { super(m); }
  }
  return {
    invoke: vi.fn(),
    FakeEdgeErr,
    legacyResolve: vi.fn(async (_b: string, u: string) => `signed:${u}`),
  };
});
vi.mock("@/lib/edgeFunction", () => ({ invokeEdgeFunction: (...a: unknown[]) => invoke(...a), EdgeFunctionError: FakeEdgeErr }));
vi.mock("@/lib/connectivity", () => ({ isOnlineNow: () => true }));
vi.mock("@/lib/telemetry", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/mediaCache", () => ({ cacheMediaInBackground: vi.fn(), deleteLocalMedia: vi.fn(), getLocalMediaUrl: vi.fn(async () => null) }));
vi.mock("@/services/media/legacySupabaseMedia", () => ({ resolveLegacyMediaUrl: (b: string, u: string) => legacyResolve(b, u), uploadLegacyChatFile: vi.fn() }));

import { deleteMedia, getMediaUrl, uploadMedia, MediaError } from "@/services/media/mediaService";
import type { UploadState } from "@/services/media/types";

const MID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, ...new Array(40).fill(1)])], { type: "image/jpeg" });
const sign = { ok: true, media_id: MID, uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload", apiKey: "k", timestamp: 1, signature: "s", publicId: `duospace/users/u/gallery/${MID}`, type: "authenticated" };
const asset = { id: MID, scope: "gallery", media_type: "image" };

// Minimal XHR double.
let xhrBehaviour: "ok" | "fail400" | "network" | "hang" = "ok";
let lastXhr: FakeXHR | null = null;
const sent: FormData[] = [];
class FakeXHR {
  upload: { onprogress?: (e: unknown) => void } = {};
  status = 0; responseText = ""; timeout = 0;
  onload?: () => void; onerror?: () => void; ontimeout?: () => void; onabort?: () => void;
  open() { lastXhr = this; }
  abort() { this.onabort?.(); }
  send(form: FormData) {
    sent.push(form);
    if (xhrBehaviour === "hang") return;
    queueMicrotask(() => {
      if (xhrBehaviour === "network") return this.onerror?.();
      if (xhrBehaviour === "fail400") { this.status = 400; this.responseText = JSON.stringify({ error: { message: "Invalid signature" } }); return this.onload?.(); }
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = 200; this.responseText = "{}"; this.onload?.();
    });
  }
}
vi.stubGlobal("XMLHttpRequest", FakeXHR);

beforeEach(() => { invoke.mockReset(); legacyResolve.mockClear(); xhrBehaviour = "ok"; sent.length = 0; });

describe("uploadMedia — Cloudinary path", () => {
  it("validates -> signs -> uploads signed authenticated form -> registers -> complete", async () => {
    invoke.mockImplementation(async (name: string) => (name === "sign-cloudinary-upload" ? sign : { ok: true, asset }));
    const states: UploadState[] = [];
    const r = await uploadMedia(jpeg(), { scope: "gallery", onState: (s) => states.push(s) });
    expect(states).toEqual(["validating", "signing", "uploading", "processing", "registering", "complete"]);
    expect(r).toMatchObject({ mediaId: MID, ref: `media:${MID}` });
    const form = sent[0];
    expect(form.get("type")).toBe("authenticated");
    expect(form.get("public_id")).toBe(sign.publicId);
    expect(form.get("signature")).toBe("s");
    expect(form.has("api_secret")).toBe(false);
    expect(invoke).toHaveBeenCalledWith("sign-cloudinary-upload", expect.objectContaining({ body: expect.objectContaining({ scope: "gallery", mime_type: "image/jpeg" }) }));
  });

  it("invalid file never reaches the network and ends in 'failed'", async () => {
    const states: UploadState[] = [];
    await expect(uploadMedia(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }), { scope: "gallery", onState: (s) => states.push(s) }))
      .rejects.toMatchObject({ code: "INVALID_FILE" });
    expect(invoke).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("failed");
  });

  it("surfaces NOT_CONFIGURED so callers can fall back to legacy storage", async () => {
    invoke.mockRejectedValue(new FakeEdgeErr("x", "http", "r", 503, undefined, { code: "NOT_CONFIGURED" }));
    await expect(uploadMedia(jpeg(), { scope: "gallery" })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("maps 401 to UNAUTHORIZED (auth expiry) and ends failed", async () => {
    invoke.mockRejectedValue(new FakeEdgeErr("x", "http", "r", 401));
    const states: UploadState[] = [];
    await expect(uploadMedia(jpeg(), { scope: "gallery", onState: (s) => states.push(s) })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(states.at(-1)).toBe("failed");
  });

  it("does not retry a Cloudinary rejection (4xx) and reports its message", async () => {
    invoke.mockResolvedValue(sign); xhrBehaviour = "fail400";
    await expect(uploadMedia(jpeg(), { scope: "gallery" })).rejects.toMatchObject({ code: "UPLOAD_FAILED", message: "Invalid signature" });
    expect(sent).toHaveLength(1);
  });

  it("retries network failures with the same signature, then fails (never hangs)", async () => {
    invoke.mockResolvedValue(sign); xhrBehaviour = "network";
    vi.useFakeTimers();
    const p = uploadMedia(jpeg(), { scope: "gallery" }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe("NETWORK");
    expect(sent).toHaveLength(3);
    expect(invoke).toHaveBeenCalledTimes(1); // signed once
  });

  it("cancellation aborts the transfer and ends 'cancelled'", async () => {
    invoke.mockResolvedValue(sign); xhrBehaviour = "hang";
    const ac = new AbortController(); const states: UploadState[] = [];
    const p = uploadMedia(jpeg(), { scope: "gallery", signal: ac.signal, onState: (s) => states.push(s) }).catch((e) => e);
    await vi.waitFor(() => expect(lastXhr).not.toBeNull());
    await vi.waitFor(() => expect(sent.length).toBe(1));
    ac.abort();
    expect(await p).toMatchObject({ code: "CANCELLED" });
    expect(states.at(-1)).toBe("cancelled");
  });

  it("Cloudinary succeeds but registration fails: error carries mediaId so registration can be retried", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "sign-cloudinary-upload") return sign;
      throw new FakeEdgeErr("x", "http", "r", 500, undefined, { code: "DB_FAILED", retryable: false });
    });
    const err = await uploadMedia(jpeg(), { scope: "gallery" }).catch((e) => e);
    expect(err).toMatchObject({ code: "REGISTER_FAILED", mediaId: MID, retryable: true });
  });

  it("de-duplicates concurrent submissions with the same clientUploadId", async () => {
    invoke.mockImplementation(async (name: string) => (name === "sign-cloudinary-upload" ? sign : { ok: true, asset }));
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const f = jpeg();
    const [a, b] = await Promise.all([uploadMedia(f, { scope: "gallery", clientUploadId: id }), uploadMedia(f, { scope: "gallery", clientUploadId: id })]);
    expect(a).toBe(b);
    expect(invoke.mock.calls.filter((c) => c[0] === "sign-cloudinary-upload")).toHaveLength(1);
  });
});

describe("getMediaUrl — dual read", () => {
  it("legacy URLs go through the existing Supabase resolver, untouched", async () => {
    expect(await getMediaUrl("https://x.supabase.co/storage/v1/object/public/gallery/u/a.jpg", { bucket: "gallery" })).toBe("signed:https://x.supabase.co/storage/v1/object/public/gallery/u/a.jpg");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("media refs ask the signing function (authorization happens there) and return its URL", async () => {
    invoke.mockResolvedValue({ ok: true, results: { [`${MID}|GALLERY_PREVIEW`]: { url: "https://res.cloudinary.com/demo/image/authenticated/s--abc--/t/p", cache_until: new Date(Date.now() + 3.6e6).toISOString(), media_type: "image" } } });
    expect(await getMediaUrl(`media:${MID}`, { bucket: "gallery" })).toBe("https://res.cloudinary.com/demo/image/authenticated/s--abc--/t/p");
    expect(legacyResolve).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("signed-cloudinary-url", { body: { items: [{ media_id: MID, variant: "GALLERY_PREVIEW" }] } });
  });
  it("returns null (not a broken URL) when the server says not found / not permitted", async () => {
    const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    invoke.mockResolvedValue({ ok: true, results: { [`${other}|CHAT_THUMBNAIL`]: { error: "NOT_FOUND" } } });
    expect(await getMediaUrl(`media:${other}`, { bucket: "chat-files" })).toBeNull();
  });
  it("returns null if the signing call itself fails", async () => {
    const other = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    invoke.mockRejectedValue(new FakeEdgeErr("x", "network"));
    expect(await getMediaUrl(`media:${other}`, { bucket: "gallery", variant: "FULLSCREEN" })).toBeNull();
  });
});

describe("deleteMedia", () => {
  it("is a no-op for legacy refs (callers keep their existing Supabase deletion)", async () => {
    await deleteMedia("https://x/storage/v1/object/public/gallery/u/a.jpg");
    await deleteMedia(null);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("sends only the media_assets id — never a Cloudinary public_id", async () => {
    invoke.mockResolvedValue({ ok: true });
    await deleteMedia(`media:${MID}`, "gallery");
    expect(invoke).toHaveBeenCalledWith("delete-cloudinary-media", { body: { media_id: MID } });
  });
  it("treats 404 (already gone / not owner) as nothing to do, but surfaces real failures", async () => {
    invoke.mockRejectedValueOnce(new FakeEdgeErr("x", "http", "r", 404));
    await expect(deleteMedia(`media:${MID}`)).resolves.toBeUndefined();
    invoke.mockRejectedValueOnce(new FakeEdgeErr("x", "http", "r", 502, undefined, { code: "CLOUDINARY_DELETE_FAILED" }));
    await expect(deleteMedia(`media:${MID}`)).rejects.toMatchObject({ code: "DELETE_FAILED", retryable: true });
  });
});
