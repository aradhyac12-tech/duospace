/** Human-readable size: 512 B, 1.5 KB, 3.0 MB, 250 MB, 1.2 GB. */
export const formatBytes = (b: number): string => {
  if (!b || b < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
};
