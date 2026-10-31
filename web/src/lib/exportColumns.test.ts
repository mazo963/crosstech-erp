// 実行: node --experimental-strip-types --test web/src/lib/exportColumns.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCsv } from "./csv.ts";
import { crc32, makeZip } from "./zip.ts";
import { RECEIVED_COLS, rowsOf, safeName, uniquePaths } from "./exportColumns.ts";

test("CSV: BOM・CRLF・引用符・式の無効化", () => {
  const csv = toCsv(["a", "b"], [["x,y", 'say "hi"'], ["=SUM(A1)", "+1"], [-5, null], [true, "line\nbreak"], ["-", "@x"]]);
  assert.ok(csv.startsWith("﻿a,b\r\n"));
  const lines = csv.split("\r\n");
  assert.equal(lines[1], '"x,y","say ""hi"""');
  assert.equal(lines[2], "'=SUM(A1),'+1");
  assert.equal(lines[3], "-5,");           // 数値の負数は式扱いにしない
  assert.equal(lines[4], 'はい,"line\nbreak"'); // セル内の改行は引用符で囲み、行の区切り（CRLF）と区別する
  assert.equal(lines[5], "'-,'@x");
});

test("CRC32: 標準の検査値", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("ZIP: Pythonで開け、日本語のファイル名と内容が一致する", { skip: spawnSync("python3", ["--version"]).status !== 0 }, () => {
  const bin = new Uint8Array([0, 1, 2, 255, 254]);
  const zip = makeZip([
    { name: "受領書類/2026-10-20_110000_テスト外注_a.pdf", data: bin },
    { name: "一覧.csv", data: new TextEncoder().encode(toCsv(["見出し"], [["値"]])) },
    { name: "空.txt", data: new Uint8Array() },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  writeFileSync(join(dir, "t.zip"), zip);
  const py = `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
n=sorted(z.namelist()); print("|".join(n)); print(list(z.read("受領書類/2026-10-20_110000_テスト外注_a.pdf")))`;
  const r = spawnSync("python3", ["-I", "-c", py, join(dir, "t.zip")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [names, content] = r.stdout.trim().split("\n");
  assert.deepEqual(names.split("|"), ["一覧.csv", "受領書類/2026-10-20_110000_テスト外注_a.pdf", "空.txt"]);
  assert.equal(content, "[0, 1, 2, 255, 254]");
  const unzip = spawnSync("unzip", ["-tq", join(dir, "t.zip")], { encoding: "utf8" });
  if (unzip.status !== null && unzip.error === undefined) assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
});

test("列の変換・ファイル名・重複", () => {
  const { headers, rows } = rowsOf(RECEIVED_COLS, [{ id: "1", kind: "scanned", doc_category: "invoice", importance: "important", amount: 100, paper_original_required: true, timestamp_status: "overdue" }]);
  assert.equal(headers[1], "保存の種類");
  assert.equal(rows[0][1], "スキャナ保存");
  assert.equal(rows[0][2], "請求書");
  assert.equal(rows[0][headers.indexOf("紙の原本の保存が必要")], true);
  assert.equal(rows[0][headers.indexOf("タイムスタンプの状況")], "期限超過（未付与）");
  assert.equal(safeName('a/b:c*d?"e<f>g|h'), "a_b_c_d__e_f_g_h");
  assert.equal(safeName("  ...隠し  "), "_隠し");
  assert.equal(safeName("あ".repeat(200)).length, 80);
  assert.deepEqual(uniquePaths(["a/x.pdf", "a/x.pdf", "a/y.pdf", "a/x.pdf"]), ["a/x.pdf", "a/x_2.pdf", "a/y.pdf", "a/x_3.pdf"]);
});
