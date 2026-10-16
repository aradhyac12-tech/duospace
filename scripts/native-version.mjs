// Shared by scripts/patch-native-permissions.mjs and the unit tests.
// Keep identical to src/lib/appUpdate/versionCode.ts (a test enforces it).
export function semverToVersionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) throw new Error(`"${version}" is not a x.y.z version`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (minor > 99 || patch > 99) throw new Error("minor and patch must be 0-99");
  if (major > 200) throw new Error("major must be 0-200");
  const code = major * 10000 + minor * 100 + patch;
  if (code <= 0) throw new Error("version must be greater than 0.0.0");
  return code;
}
