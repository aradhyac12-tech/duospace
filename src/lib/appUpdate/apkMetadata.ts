/**
 * Reads the identity of an APK in the browser, so the admin never has to type
 * the version by hand: an APK is a zip whose AndroidManifest.xml is Android
 * binary XML ("AXML"); the root <manifest> element carries `package`,
 * `versionName` and `versionCode`.
 *
 * Only the zip's central directory and the manifest entry are read (via
 * File.slice), so a several-hundred-MB APK is never loaded into memory here.
 * No dependencies; uses the platform DecompressionStream for deflated entries.
 */

export interface ApkMetadata {
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdk: number | null;
  debuggable: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const RES_XML = 0x0003;
const RES_STRING_POOL = 0x0001;
const RES_START_ELEMENT = 0x0102;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_BOOLEAN = 0x12;

async function readSlice(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot unpack the APK; enter the version manually.");
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns the bytes of one zip entry, or null if it is not in the archive. */
async function readZipEntry(file: Blob, wanted: string): Promise<Uint8Array | null> {
  const tailLen = Math.min(file.size, 22 + 0xffff);
  const tail = await readSlice(file, file.size - tailLen, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid APK (zip directory not found).");
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new Error("Zip64 archives are not supported.");

  const cd = await readSlice(file, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === SIG_CEN) {
    const method = cd.getUint16(p + 10, true);
    const compSize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (name === wanted) {
      const local = await readSlice(file, localOffset, localOffset + 30);
      if (local.getUint32(0, true) !== SIG_LOC) throw new Error("Corrupt APK (bad local header).");
      const dataStart = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      const raw = new Uint8Array(await file.slice(dataStart, dataStart + compSize).arrayBuffer());
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw);
      throw new Error(`Unsupported zip compression (${method}).`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Parses Android binary XML and returns the <manifest> (and a few related) attributes. */
export function parseBinaryManifest(buf: Uint8Array): ApkMetadata {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.byteLength < 8 || v.getUint16(0, true) !== RES_XML) {
    throw new Error("AndroidManifest.xml is not binary XML.");
  }
  const strings: string[] = [];
  const out: ApkMetadata = { packageName: null, versionName: null, versionCode: null, minSdk: null, debuggable: false };

  let pos = v.getUint16(2, true);
  while (pos + 8 <= v.byteLength) {
    const type = v.getUint16(pos, true);
    const headerSize = v.getUint16(pos + 2, true);
    const size = v.getUint32(pos + 4, true);
    if (size < 8) break;

    if (type === RES_STRING_POOL) {
      const count = v.getUint32(pos + 8, true);
      const flags = v.getUint32(pos + 16, true);
      const stringsStart = v.getUint32(pos + 20, true);
      const utf8 = (flags & 0x100) !== 0;
      for (let i = 0; i < count; i++) {
        let s = pos + stringsStart + v.getUint32(pos + headerSize + i * 4, true);
        if (utf8) {
          // two length prefixes (utf16 chars, then utf8 bytes), each 1 or 2 bytes
          let b = v.getUint8(s); s += b & 0x80 ? 2 : 1;
          b = v.getUint8(s);
          let len = b;
          if (b & 0x80) { len = ((b & 0x7f) << 8) | v.getUint8(s + 1); s += 2; } else s += 1;
          strings.push(new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset + s, len)));
        } else {
          let len = v.getUint16(s, true); s += 2;
          if (len & 0x8000) { len = ((len & 0x7fff) << 16) | v.getUint16(s, true); s += 2; }
          const chars: number[] = [];
          for (let k = 0; k < len; k++) chars.push(v.getUint16(s + k * 2, true));
          strings.push(String.fromCharCode(...chars));
        }
      }
    } else if (type === RES_START_ELEMENT) {
      const elementName = strings[v.getUint32(pos + 20, true)];
      const attrStart = v.getUint16(pos + 24, true);
      const attrSize = v.getUint16(pos + 26, true) || 20;
      const attrCount = v.getUint16(pos + 28, true);
      const base = pos + 16 + attrStart;
      for (let i = 0; i < attrCount; i++) {
        const a = base + i * attrSize;
        const name = strings[v.getUint32(a + 4, true)];
        const rawIdx = v.getInt32(a + 8, true);
        const dataType = v.getUint8(a + 15);
        const data = v.getUint32(a + 16, true);
        const str = rawIdx >= 0 ? strings[rawIdx] ?? null : dataType === TYPE_STRING ? strings[data] ?? null : null;
        const num = dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX ? data | 0 : null;

        if (elementName === "manifest") {
          if (name === "package") out.packageName = str;
          else if (name === "versionName") out.versionName = str;
          else if (name === "versionCode") out.versionCode = num;
        } else if (elementName === "uses-sdk" && name === "minSdkVersion") {
          out.minSdk = num;
        } else if (elementName === "application" && name === "debuggable") {
          out.debuggable = dataType === TYPE_BOOLEAN && data !== 0;
        }
      }
    }
    pos += size;
  }
  return out;
}

export async function readApkMetadata(file: Blob): Promise<ApkMetadata> {
  const manifest = await readZipEntry(file, "AndroidManifest.xml");
  if (!manifest) throw new Error("AndroidManifest.xml not found; this does not look like an APK.");
  return parseBinaryManifest(manifest);
}
