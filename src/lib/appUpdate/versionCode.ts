/**
 * Android versionCode / iOS CFBundleVersion for a semantic version:
 *
 *   major*10000 + minor*100 + patch      3.22.0 -> 32200
 *
 * MUST stay identical to `semverToVersionCode` in scripts/native-version.mjs
 * (used by scripts/patch-native-permissions.mjs to stamp the native project);
 * src/test/appUpdate.test.ts checks the two agree. The update check compares
 * this number against what is installed. minor/patch are limited to 0-99 so the
 * mapping is monotonic.
 */
export function semverToVersionCode(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) throw new Error(`"${version}" is not a x.y.z version`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (minor > 99 || patch > 99) throw new Error("minor and patch must be 0-99");
  if (major > 200) throw new Error("major must be 0-200");
  const code = major * 10000 + minor * 100 + patch;
  if (code <= 0) throw new Error("version must be greater than 0.0.0");
  return code;
}

export function isValidSemver(version: string): boolean {
  try {
    semverToVersionCode(version);
    return true;
  } catch {
    return false;
  }
}
