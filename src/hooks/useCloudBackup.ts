/**
 * useCloudBackup — Lovable Cloud Storage backup (replaces Google Drive flow).
 *
 *  - Encrypted (AES-GCM, PBKDF2 key from device-local secret)
 *  - Stored in private 'backups' bucket under <user_id>/<timestamp>.bin
 *  - Listable / restorable / deletable
 *  - Plus manual JSON export & import (off-device safety net)
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import storage from "@/lib/storage";

export type BackupStatus = "idle" | "backing_up" | "restoring" | "done" | "error";

export interface CloudBackupInfo {
  path: string;          // user_id/filename
  name: string;          // filename
  createdAt: string;     // ISO
  size: number;          // bytes
  messageCount: number;
  galleryCount: number;
}

const BUCKET = "backups";
const LAST_BACKUP_KEY = "duo-last-cloud-backup";
const DEVICE_SECRET_KEY = "duo-backup-device-secret";

// ─── device secret (same scheme as legacy hook so existing keys still work) ──
async function getOrCreateDeviceSecret(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key: DEVICE_SECRET_KEY });
      if (value) return value;
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const secret = btoa(String.fromCharCode(...bytes));
      await Preferences.set({ key: DEVICE_SECRET_KEY, value: secret });
      return secret;
    } catch { /* fall through */ }
  }
  let secret = localStorage.getItem(DEVICE_SECRET_KEY);
  if (!secret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secret = btoa(String.fromCharCode(...bytes));
    localStorage.setItem(DEVICE_SECRET_KEY, secret);
  }
  return secret;
}

// ─── encryption helpers ──────────────────────────────────────────────────────
async function deriveKey(password: string, salt: Uint8Array) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100_000, hash: "SHA-256" },
    keyMat,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptJSON(data: unknown, password: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  );
  // layout: [16 salt][12 iv][ciphertext]
  const buf = new Uint8Array(16 + 12 + ct.byteLength);
  buf.set(salt, 0);
  buf.set(iv, 16);
  buf.set(new Uint8Array(ct), 28);
  return new Blob([buf], { type: "application/octet-stream" });
}

async function decryptBlob(blob: Blob, password: string): Promise<any> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const salt = buf.slice(0, 16);
  const iv = buf.slice(16, 28);
  const ct = buf.slice(28);
  const key = await deriveKey(password, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// ─── data gather / apply ─────────────────────────────────────────────────────
async function gatherUserData(userId: string) {
  const [{ data: messages }, { data: gallery }, { data: profile }] = await Promise.all([
    supabase
      .from("messages")
      .select("id,sender_id,receiver_id,content,message_type,file_url,file_name,is_read,reply_to_id,disappear_at,deleted_by_sender,deleted_by_receiver,created_at")
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order("created_at", { ascending: true }),
    supabase
      .from("gallery_items")
      .select("id,file_url,file_type,file_name,is_shared,created_at")
      .eq("owner_id", userId),
    supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  return {
    version: 5,
    exportedAt: new Date().toISOString(),
    userId,
    profile,
    messages: messages || [],
    gallery: gallery || [],
  };
}

/**
 * Validate the decrypted/imported payload BEFORE touching any user data.
 * Throws a clear error if the backup doesn't belong to this account or
 * doesn't look like a valid DuoSpace export.
 */
function validatePayload(payload: unknown, userId: string): asserts payload is {
  version: number;
  userId?: string;
  messages?: unknown[];
  gallery?: unknown[];
  profile?: Record<string, unknown> | null;
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("Backup file is empty or unreadable.");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.version !== "number") {
    throw new Error("Not a valid DuoSpace backup (missing version).");
  }
  if (!p.userId || typeof p.userId !== "string") {
    throw new Error("Backup is missing an account identifier — refusing to restore.");
  }
  if (p.userId !== userId) {
    throw new Error("This backup belongs to a different account. Restore blocked.");
  }
  if (p.messages !== undefined && !Array.isArray(p.messages)) {
    throw new Error("Backup is corrupted (messages).");
  }
  if (p.gallery !== undefined && !Array.isArray(p.gallery)) {
    throw new Error("Backup is corrupted (gallery).");
  }
  // Defensive: if messages contain rows tagged to another user, block.
  if (Array.isArray(p.messages)) {
    const stray = (p.messages as Array<Record<string, unknown>>).find(
      (m) => m && m.sender_id && m.receiver_id &&
        m.sender_id !== userId && m.receiver_id !== userId,
    );
    if (stray) throw new Error("Backup contains messages from another account. Restore blocked.");
  }
}

async function applyRestore(payload: any, userId: string) {
  validatePayload(payload, userId);
  const messages = (payload.messages ?? []) as any[];
  const gallery = (payload.gallery ?? []) as any[];
  for (let i = 0; i < messages.length; i += 100) {
    await supabase.from("messages").upsert(
      messages.slice(i, i + 100),
      { onConflict: "id", ignoreDuplicates: true },
    );
  }
  if (gallery.length) {
    await supabase.from("gallery_items").upsert(
      gallery.map((g) => ({ ...g, owner_id: userId })),
      { onConflict: "id", ignoreDuplicates: true },
    );
  }
}

// ─── hook ────────────────────────────────────────────────────────────────────
// Lockout: prevent overlapping or rapidly-repeated backup/restore jobs.
const COOLDOWN_MS = 3000;

export const useCloudBackup = () => {
  const { user } = useAuth();
  const [status, setStatus] = useState<BackupStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [backups, setBackups] = useState<CloudBackupInfo[]>([]);
  const [lastBackup, setLastBackup] = useState<string | null>(null);

  // Concurrency guard — survives rapid React re-renders, unlike state.
  const busyRef = useRef(false);
  const lastFinishedAtRef = useRef(0);

  /** Acquire the single-job lock. Returns false if a job is in flight or cooldown active. */
  const acquireLock = useCallback((kind: "backup" | "restore") => {
    if (busyRef.current) {
      setError(`A ${kind === "backup" ? "backup" : "restore"} is already in progress.`);
      setStatus("error");
      return false;
    }
    const sinceLast = Date.now() - lastFinishedAtRef.current;
    if (sinceLast < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
      setError(`Please wait ${wait}s before starting another ${kind}.`);
      setStatus("error");
      return false;
    }
    busyRef.current = true;
    return true;
  }, []);

  const releaseLock = useCallback(() => {
    busyRef.current = false;
    lastFinishedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    const saved = storage.get(LAST_BACKUP_KEY);
    if (saved) setLastBackup(saved);
  }, []);

  const listBackups = useCallback(async (): Promise<CloudBackupInfo[]> => {
    if (!user) return [];
    try {
      const { data, error: listErr } = await supabase.storage
        .from(BUCKET)
        .list(user.id, { limit: 50, sortBy: { column: "created_at", order: "desc" } });
      if (listErr) throw listErr;
      const list: CloudBackupInfo[] = (data || [])
        .filter((f) => f.name && !f.name.endsWith("/"))
        .map((f) => {
          const meta: any = (f as any).metadata || {};
          return {
            path: `${user.id}/${f.name}`,
            name: f.name,
            createdAt: (f as any).created_at || new Date().toISOString(),
            size: meta.size || 0,
            messageCount: 0,
            galleryCount: 0,
          };
        });
      setBackups(list);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, [user]);

  // Upload with retry: 3 attempts, exponential backoff (0.5s, 1.5s, 3s).
  // Saves a half-finished backup from being abandoned on a flaky network.
  const uploadWithRetry = useCallback(async (path: string, blob: Blob) => {
    const delays = [0, 500, 1500, 3000];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, blob, { contentType: "application/octet-stream", upsert: false });
      if (!upErr) return;
      lastErr = upErr;
      const msg = (upErr as any)?.message?.toLowerCase?.() || "";
      // Retryable: network / 5xx. Non-retryable: 409 conflict, 403 forbidden.
      if (msg.includes("already exists") || msg.includes("forbidden") || msg.includes("unauthorized")) {
        throw upErr;
      }
    }
    throw lastErr;
  }, []);

  const backup = useCallback(async () => {
    if (!user) return;
    if (!acquireLock("backup")) return;
    setStatus("backing_up");
    setError(null);
    setProgress(5);
    try {
      const data = await gatherUserData(user.id);
      setProgress(40);
      const secret = await getOrCreateDeviceSecret();
      const blob = await encryptJSON(data, secret);
      setProgress(65);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = `${user.id}/backup_${ts}.bin`;
      await uploadWithRetry(path, blob);
      setProgress(95);
      const now = new Date().toISOString();
      storage.set(LAST_BACKUP_KEY, now);
      setLastBackup(now);
      await listBackups();
      setProgress(100);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      releaseLock();
    }
  }, [user, listBackups, acquireLock, releaseLock, uploadWithRetry]);

  const restore = useCallback(async (path: string) => {
    if (!user) return;
    if (!acquireLock("restore")) return;
    setStatus("restoring");
    setError(null);
    setProgress(10);
    try {
      const { data, error: dlErr } = await supabase.storage.from(BUCKET).download(path);
      if (dlErr || !data) throw dlErr || new Error("Download failed");
      setProgress(45);
      const secret = await getOrCreateDeviceSecret();
      const payload = await decryptBlob(data, secret);
      setProgress(70);
      // applyRestore now validates ownership BEFORE writing anything.
      await applyRestore(payload, user.id);
      setProgress(100);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed (wrong device key?)");
      setStatus("error");
    } finally {
      releaseLock();
    }
  }, [user, acquireLock, releaseLock]);

  const deleteBackup = useCallback(async (path: string) => {
    if (!user) return;
    await supabase.storage.from(BUCKET).remove([path]);
    await listBackups();
  }, [user, listBackups]);

  // ── Manual export: download a plain JSON file (NOT encrypted, off-device safety) ──
  const exportJSON = useCallback(async () => {
    if (!user) return;
    if (!acquireLock("backup")) return;
    setStatus("backing_up");
    try {
      const data = await gatherUserData(user.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `duospace-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      releaseLock();
    }
  }, [user, acquireLock, releaseLock]);

  const importJSON = useCallback(async (file: File) => {
    if (!user) return;
    if (!acquireLock("restore")) return;
    setStatus("restoring");
    setError(null);
    setProgress(20);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      setProgress(60);
      await applyRestore(payload, user.id);
      setProgress(100);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      setStatus("error");
    } finally {
      releaseLock();
    }
  }, [user, acquireLock, releaseLock]);

  const exportDeviceSecret = useCallback(() => getOrCreateDeviceSecret(), []);

  return {
    status, error, progress, backups, lastBackup,
    listBackups, backup, restore, deleteBackup,
    exportJSON, importJSON, exportDeviceSecret,
  };
};
