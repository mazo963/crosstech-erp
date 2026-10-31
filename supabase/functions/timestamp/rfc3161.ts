// RFC 3161（タイムスタンププロトコル）の要求の作成と、応答の解析・照合。Deno・Node のどちらでも動く（標準APIのみ）。
// ここで行うのは「要求が正しく作られ、応答が許可で、対象のハッシュ・nonceが一致し、時刻を読み取れること」の確認まで。
// 署名・証明書の検証（TSAが正当か）は行わない。監査・再検証は scripts/verify_timestamp.sh（OpenSSL）で行う。

const OID_SHA256 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];

export type TimeStampResult = {
  status: number;       // 0 = granted, 1 = grantedWithMods
  genTime: Date;
  serialHex: string;
  policyOid: string;
  imprintHex: string;
  token: Uint8Array;    // TimeStampToken（ContentInfo, DER）
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

function lengthBytes(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
const tlv = (tag: number, ...content: Uint8Array[]) => {
  const body = concat(...content);
  return concat(Uint8Array.of(tag), lengthBytes(body.length), body);
};

export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error("16進数ではありません");
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}
export const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** TimeStampReq（SHA-256、証明書要求あり）。nonce は正の整数として符号化する。 */
export function buildTimeStampReq(sha256Hex: string, nonce: Uint8Array): Uint8Array {
  const hash = hexToBytes(sha256Hex);
  if (hash.length !== 32) throw new Error("SHA-256（64桁の16進数）を指定してください");
  const n = Uint8Array.from(nonce);
  n[0] &= 0x7f;
  if (n[0] === 0) n[0] = 1;
  return tlv(0x30,
    tlv(0x02, Uint8Array.of(1)),
    tlv(0x30, tlv(0x30, tlv(0x06, Uint8Array.from(OID_SHA256)), tlv(0x05)), tlv(0x04, hash)),
    tlv(0x02, n),
    tlv(0x01, Uint8Array.of(0xff)),
  );
}

type Node = { tag: number; start: number; end: number; offset: number };
function read(buf: Uint8Array, off: number): Node {
  if (off + 2 > buf.length) throw new Error("応答が途中で終わっています");
  const tag = buf[off];
  let len = buf[off + 1];
  let p = off + 2;
  if (len & 0x80) {
    const k = len & 0x7f;
    if (k === 0 || k > 4) throw new Error("対応していない長さの符号化です");
    len = 0;
    for (let i = 0; i < k; i++) len = len * 256 + buf[p++];
  }
  if (p + len > buf.length) throw new Error("応答の長さが不正です");
  return { tag, start: p, end: p + len, offset: off };
}
const expect = (n: Node, tag: number, what: string) => {
  if (n.tag !== tag) throw new Error(`応答の形式が想定と違います（${what}）`);
  return n;
};
const intValue = (buf: Uint8Array, n: Node) => bytesToHex(buf.subarray(n.start, n.end));
const oidString = (b: Uint8Array) => {
  const parts: number[] = [Math.floor(b[0] / 40), b[0] % 40];
  for (let i = 1, v = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join(".");
};

export function parseGeneralizedTime(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new Error("時刻の形式が不正です");
  const ms = m[7] ? Math.round(Number("0." + m[7]) * 1000) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms));
}

/** TimeStampResp を解析し、許可されていること・ハッシュとnonceが要求と一致することを確認する。 */
export function parseTimeStampResp(resp: Uint8Array, expectedSha256Hex: string, expectedNonce?: Uint8Array): TimeStampResult {
  const top = expect(read(resp, 0), 0x30, "TimeStampResp");
  const info = expect(read(resp, top.start), 0x30, "PKIStatusInfo");
  const statusNode = expect(read(resp, info.start), 0x02, "status");
  const status = resp[statusNode.start];
  if (status !== 0 && status !== 1) throw new Error(`タイムスタンプ局が付与を拒否しました（status=${status}）`);

  const tokenNode = expect(read(resp, info.end), 0x30, "TimeStampToken");
  const token = resp.subarray(tokenNode.offset, tokenNode.end);
  // ContentInfo → [0] SignedData → encapContentInfo → [0] OCTET STRING → TSTInfo
  const ct = expect(read(resp, tokenNode.start), 0x06, "contentType");
  const content = expect(read(resp, ct.end), 0xa0, "content");
  const signed = expect(read(resp, content.start), 0x30, "SignedData");
  const version = read(resp, signed.start);
  const digestAlgs = read(resp, version.end);
  const encap = expect(read(resp, digestAlgs.end), 0x30, "encapContentInfo");
  const eType = expect(read(resp, encap.start), 0x06, "eContentType");
  const eContent = expect(read(resp, eType.end), 0xa0, "eContent");
  const octet = expect(read(resp, eContent.start), 0x04, "eContent OCTET STRING");
  const tst = expect(read(resp, octet.start), 0x30, "TSTInfo");

  const tstVersion = read(resp, tst.start);
  const policy = expect(read(resp, tstVersion.end), 0x06, "policy");
  const imprint = expect(read(resp, policy.end), 0x30, "messageImprint");
  const alg = expect(read(resp, imprint.start), 0x30, "hashAlgorithm");
  const hashed = expect(read(resp, alg.end), 0x04, "hashedMessage");
  const serial = expect(read(resp, imprint.end), 0x02, "serialNumber");
  const gen = expect(read(resp, serial.end), 0x18, "genTime");

  const imprintHex = bytesToHex(resp.subarray(hashed.start, hashed.end));
  if (imprintHex !== expectedSha256Hex.toLowerCase()) throw new Error("応答のハッシュが、要求したハッシュと一致しません");

  let nonceHex: string | null = null;
  for (let p = gen.end; p < tst.end;) {
    const n = read(resp, p);
    if (n.tag === 0x02) nonceHex = intValue(resp, n);
    p = n.end;
  }
  if (expectedNonce) {
    const want = Uint8Array.from(expectedNonce);
    want[0] &= 0x7f;
    if (want[0] === 0) want[0] = 1;
    const norm = (h: string) => h.replace(/^(00)+/, "");
    if (nonceHex === null || norm(nonceHex) !== norm(bytesToHex(want))) throw new Error("応答のnonceが要求と一致しません");
  }
  return {
    status,
    genTime: parseGeneralizedTime(new TextDecoder().decode(resp.subarray(gen.start, gen.end))),
    serialHex: intValue(resp, serial),
    policyOid: oidString(resp.subarray(policy.start, policy.end)),
    imprintHex,
    token: Uint8Array.from(token),
  };
}
