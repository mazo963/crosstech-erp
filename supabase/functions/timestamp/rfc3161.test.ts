// 実行: node --experimental-strip-types --test supabase/functions/timestamp/rfc3161.test.ts
// OpenSSL でテスト用の時刻認証局（TSA）を作り、本物の RFC 3161 応答で要求・解析を確認する（OpenSSL が無ければスキップ）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildTimeStampReq, parseGeneralizedTime, parseTimeStampResp } from "./rfc3161.ts";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const sh = (dir: string, ...args: string[]) => {
  const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `openssl ${args.join(" ")}\n${r.stderr}`);
  return r.stdout + r.stderr;
};

function makeTsa() {
  const dir = mkdtempSync(join(tmpdir(), "tsa-"));
  sh(dir, "genrsa", "-out", "ca.key", "2048");
  sh(dir, "req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=Test CA", "-days", "2", "-out", "ca.crt");
  sh(dir, "genrsa", "-out", "tsa.key", "2048");
  sh(dir, "req", "-new", "-key", "tsa.key", "-subj", "/CN=Test TSA", "-out", "tsa.csr");
  writeFileSync(join(dir, "ext.cnf"), "extendedKeyUsage = critical,timeStamping\n");
  sh(dir, "x509", "-req", "-in", "tsa.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext.cnf", "-out", "tsa.crt");
  writeFileSync(join(dir, "tsaserial"), "0A\n");
  writeFileSync(join(dir, "tsa.cnf"), [
    "[tsa]", "default_tsa = t", "[t]", `dir = ${dir}`, "serial = $dir/tsaserial", "crypto_device = builtin",
    "signer_cert = $dir/tsa.crt", "certs = $dir/ca.crt", "signer_key = $dir/tsa.key", "signer_digest = sha256",
    "default_policy = 1.2.3.4.1", "digests = sha256", "accuracy = secs:1", "ordering = yes", "tsa_name = yes", "",
  ].join("\n"));
  return dir;
}

test("本物のTSA応答: 要求の作成・応答の解析・OpenSSLでの検証", { skip: !hasOpenssl }, () => {
  const dir = makeTsa();
  const data = Buffer.from("%PDF-1.4 テスト用の請求書");
  const hash = createHash("sha256").update(data).digest("hex");
  const nonce = Uint8Array.from([0x91, 1, 2, 3, 4, 5, 6, 7]); // 先頭ビットが立っていても正の整数として符号化される
  writeFileSync(join(dir, "req.tsq"), buildTimeStampReq(hash, nonce));
  sh(dir, "ts", "-query", "-in", "req.tsq", "-text"); // OpenSSLが要求として読めること
  sh(dir, "ts", "-reply", "-config", "tsa.cnf", "-queryfile", "req.tsq", "-out", "resp.tsr");

  const resp = Uint8Array.from(readFileSync(join(dir, "resp.tsr")));
  const r = parseTimeStampResp(resp, hash, nonce);
  assert.equal(r.status, 0);
  assert.equal(r.policyOid, "1.2.3.4.1");
  assert.equal(r.serialHex, "0b"); // OpenSSL は番号ファイルを先に1つ進めてから使う
  assert.equal(r.imprintHex, hash);
  assert.ok(Math.abs(r.genTime.getTime() - Date.now()) < 60_000, `genTime=${r.genTime.toISOString()}`);

  // 取り出したトークンが、OpenSSLで検証できる（署名・証明書・ハッシュ）
  writeFileSync(join(dir, "token.tst"), r.token);
  writeFileSync(join(dir, "data.bin"), data);
  const out = sh(dir, "ts", "-verify", "-in", "token.tst", "-token_in", "-data", "data.bin", "-CAfile", "ca.crt");
  assert.match(out, /Verification: OK/);
  // 内容が違えば検証に失敗する
  writeFileSync(join(dir, "data2.bin"), Buffer.from("改ざん"));
  const bad = spawnSync("openssl", ["ts", "-verify", "-in", "token.tst", "-token_in", "-data", "data2.bin", "-CAfile", "ca.crt"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(bad.status, 0);

  // ハッシュ・nonce が違う応答は拒否
  assert.throws(() => parseTimeStampResp(resp, createHash("sha256").update("別").digest("hex"), nonce), /ハッシュ/);
  assert.throws(() => parseTimeStampResp(resp, hash, Uint8Array.from([0x12, 1, 2, 3, 4, 5, 6, 7])), /nonce/);
});

test("付与拒否・壊れた応答・時刻の形式", () => {
  const rejected = Uint8Array.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02]); // status = 2 (rejection)
  assert.throws(() => parseTimeStampResp(rejected, "00".repeat(32)), /拒否/);
  assert.throws(() => parseTimeStampResp(Uint8Array.from([0x30, 0x10, 0x30]), "00".repeat(32)));
  assert.throws(() => buildTimeStampReq("abcd", Uint8Array.of(1)), /SHA-256/);
  assert.equal(parseGeneralizedTime("20261101123456Z").toISOString(), "2026-11-01T12:34:56.000Z");
  assert.equal(parseGeneralizedTime("20261101123456.250Z").getUTCMilliseconds(), 250);
  assert.throws(() => parseGeneralizedTime("2026-11-01"));
});
