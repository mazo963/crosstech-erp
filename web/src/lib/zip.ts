// 無圧縮（store）のZIPを作る最小の実装。ファイル名はUTF-8（日本語可）。依存ライブラリなし。
export type ZipEntry = { name: string; data: Uint8Array; date?: Date };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const dosTime = (d: Date) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = (d: Date) => ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

export function makeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length > 65535) throw new Error("ファイル数が多すぎます（65535件まで）");
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const d = e.date ?? new Date();
    const crc = crc32(e.data);
    if (e.data.length > 0xfffffff0 || offset > 0xfffffff0) throw new Error("ZIPが大きすぎます（4GB未満）");
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, dosTime(d), true); local.setUint16(12, dosDate(d), true); local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true); local.setUint32(22, e.data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime(d), true); cd.setUint16(14, dosDate(d), true); cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true); cd.setUint32(24, e.data.length, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(all.reduce((n, p) => n + p.length, 0)));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}
