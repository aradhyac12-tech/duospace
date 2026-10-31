/** Minimal x.y.z compare for the app-update gate. Non-numeric/short input is treated as 0. */
export function parseVersion(v: string | null | undefined): [number, number, number] {
  const parts = String(v ?? "").trim().replace(/^v/i, "").split(".");
  const n = (i: number) => {
    const x = parseInt(parts[i] ?? "0", 10);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  };
  return [n(0), n(1), n(2)];
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

export type UpdateVerdict = "ok" | "available" | "required";

/** required: running < min supported · available: running < latest · else ok. */
export function updateVerdict(running: string, latest: string, minSupported: string): UpdateVerdict {
  if (compareVersions(running, minSupported) < 0) return "required";
  if (compareVersions(running, latest) < 0) return "available";
  return "ok";
}
