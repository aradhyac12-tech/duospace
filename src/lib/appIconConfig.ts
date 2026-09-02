import { idbGet, idbSet, idbDelete, idbKeys } from "@/lib/idbStore";
import type { IconConfig } from "@/lib/iconGenerator";

const KEY_PREFIX = "icon-config:";
const keyFor = (appId: string) => `${KEY_PREFIX}${appId}`;

export interface StoredAppIconConfig {
  appId: string;
  /** Which preset this configuration started from, or null for a from-scratch custom icon. */
  presetId: string | null;
  config: IconConfig;
  /** Set whenever an asset export succeeds, so the UI can show "assets are current". */
  lastExportedAt: number | null;
  updatedAt: number;
}

export const getAppIconConfig = async (appId: string): Promise<StoredAppIconConfig | null> => {
  const raw = await idbGet(keyFor(appId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredAppIconConfig;
    if (!parsed || typeof parsed !== "object" || !parsed.config) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const setAppIconConfig = async (appId: string, presetId: string | null, config: IconConfig): Promise<void> => {
  const existing = await getAppIconConfig(appId);
  const record: StoredAppIconConfig = {
    appId,
    presetId,
    config,
    lastExportedAt: existing?.lastExportedAt ?? null,
    updatedAt: Date.now(),
  };
  await idbSet(keyFor(appId), JSON.stringify(record));
};

export const markAppIconExported = async (appId: string): Promise<void> => {
  const existing = await getAppIconConfig(appId);
  if (!existing) return;
  existing.lastExportedAt = Date.now();
  await idbSet(keyFor(appId), JSON.stringify(existing));
};

export const deleteAppIconConfig = async (appId: string): Promise<void> => {
  await idbDelete(keyFor(appId));
};

/** Every appId that currently has a saved icon config (used to detect orphaned configs after an app is deleted). */
export const listConfiguredAppIds = async (): Promise<string[]> => {
  const keys = await idbKeys();
  return keys.filter(k => k.startsWith(KEY_PREFIX)).map(k => k.slice(KEY_PREFIX.length));
};
