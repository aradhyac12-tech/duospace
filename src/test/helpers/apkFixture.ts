import { deflateRawSync } from "node:zlib";

/** Builds a minimal but structurally real APK (zip + binary AndroidManifest.xml) for tests. */
function u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

export function buildBinaryManifest(o: {
  pkg: string; versionName: string; versionCode: number; minSdk?: number; debuggable?: boolean; utf8?: boolean;
}): Buffer {
  const strs = ["versionCode", "versionName", "package", "manifest", o.versionName, o.pkg,
    "uses-sdk", "minSdkVersion", "application", "debuggable"];
  const enc = (s: string) => {
    if (o.utf8) {
      const b = Buffer.from(s, "utf8");
      return Buffer.concat([Buffer.from([s.length, b.length]), b, Buffer.from([0])]);
    }
    return Buffer.concat([u16(s.length), Buffer.from(s, "utf16le"), u16(0)]);
  };
  const encoded = strs.map(enc);
  const offsets: number[] = []; let acc = 0;
  for (const e of encoded) { offsets.push(acc); acc += e.length; }
  while (acc % 4) { encoded.push(Buffer.from([0])); acc++; }
  const hdr = 28, stringsStart = hdr + strs.length * 4;
  const pool = Buffer.concat([
    u16(0x0001), u16(hdr), u32(stringsStart + acc), u32(strs.length), u32(0), u32(o.utf8 ? 0x100 : 0),
    u32(stringsStart), u32(0), ...offsets.map(u32), ...encoded,
  ]);
  const attr = (nameIdx: number, raw: number, type: number, data: number) =>
    Buffer.concat([u32(0xffffffff), u32(nameIdx), u32(raw), u16(8), Buffer.from([0, type]), u32(data)]);
  const start = (nameIdx: number, attrs: Buffer[]) => {
    const body = Buffer.concat([u32(0xffffffff), u32(nameIdx), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0), ...attrs]);
    return Buffer.concat([u16(0x0102), u16(16), u32(16 + body.length), u32(1), u32(0xffffffff), body]);
  };
  const nodes = [
    start(3, [attr(0, -1, 0x10, o.versionCode), attr(1, 4, 0x03, 4), attr(2, 5, 0x03, 5)]),
    ...(o.minSdk ? [start(6, [attr(7, -1, 0x10, o.minSdk)])] : []),
    start(8, o.debuggable ? [attr(9, -1, 0x12, 0xffffffff)] : []),
  ];
  const body = Buffer.concat([pool, ...nodes]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + body.length), body]);
}

export function buildZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const comp = e.deflate ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(e.deflate ? 8 : 0), u16(0), u16(0), u32(0),
      u32(comp.length), u32(e.data.length), u16(name.length), u16(0), name, comp]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(e.deflate ? 8 : 0), u16(0), u16(0), u32(0),
      u32(comp.length), u32(e.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name]));
    parts.push(local); off += local.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(off), u16(0)]);
}

export function buildApk(o: Parameters<typeof buildBinaryManifest>[0] & { deflate?: boolean }): Buffer {
  return buildZip([
    { name: "classes.dex", data: Buffer.alloc(2048, 7) },
    { name: "AndroidManifest.xml", data: buildBinaryManifest(o), deflate: o.deflate },
  ]);
}
