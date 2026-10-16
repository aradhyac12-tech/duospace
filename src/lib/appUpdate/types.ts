export type UpdatePlatform = "android" | "ios";

/** What get_latest_app_release returns (never includes the storage path). */
/** The app that is running right now (native values, not the JS bundle's). */
export interface InstalledApp {
  versionName: string;
  versionCode: number;
  /** Android applicationId / iOS bundle id; null when the platform can't tell. */
  packageName?: string | null;
}

export interface ReleaseInfo {
  id: string;
  platform: UpdatePlatform;
  /** The package the uploaded file belongs to (absent on servers that predate the check). */
  package_name?: string | null;
  version_name: string;
  version_code: number;
  release_notes: string;
  /** true when ANY published release newer than the installed build is mandatory. */
  mandatory: boolean;
  file_size_bytes: number | null;
  sha256: string | null;
  has_file: boolean;
  external_url: string | null;
  published_at: string | null;
}

export type CellularPolicy = "wifi-only" | "ask" | "always";
export type ConnectionKind = "wifi" | "cellular" | "none" | "unknown";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "confirm_cellular"
  | "downloading"
  | "waiting_wifi"
  | "ready"
  | "installing"
  | "needs_permission"
  | "handoff"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** false on web, in Play-installed builds, or when disabled by config. */
  supported: boolean;
  installed: InstalledApp | null;
  release: ReleaseInfo | null;
  progress: { bytes: number; total: number };
  error: string | null;
  lastCheckedAt: number | null;
  connection: ConnectionKind;
  cellularPolicy: CellularPolicy;
  /** the user chose "Later" for this release recently (never true when mandatory) */
  dismissed: boolean;
}

export type DownloadResponse =
  | { kind: "apk"; url: string; file_name: string; sha256: string; size: number }
  | { kind: "ios-ota"; url: string }
  | { kind: "external"; url: string };
