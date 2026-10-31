// 実行: node --experimental-strip-types --test web/src/lib/docPdf.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { makeDocPdf, pdfFileName, jst } from "./docPdf.ts";

const font = new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/fonts/CrosstechSansJP-Regular.ttf")));
const issuer = { company_name: "株式会社クロステック", invoice_reg_no: "T1234567890123", postal_code: "000-0000", address: "東京都千代田区1-2-3", tel: "03-1111-2222", email: null };
const customer = { id: "c1", name: "株式会社髙橋精機", postal_code: "210-0001", address: "神奈川県川崎市1-1", department: "購買部", contact_name: "山田" };
const meta = { version: 2, issued_at: "2026-10-31T01:23:00Z", content_sha256: "ab12cd34ef56".padEnd(64, "0"), voided: false, void_reason: null };
const invoice = {
  doc_type: "invoice", doc_no: "INV2610-0001", doc_date: "2026-10-31", official: true, mf_invoice_no: null, bank_info: "○○銀行 △△支店 普通 1234567 カ）クロステック", due_date: "2026-11-30", period_from: null, period_to: "2026-10-31",
  issuer, customer, subtotal: 13545, tax: 1144, total: 14689,
  tax_breakdown: [{ rate: 0.1, reduced: false, base: 10045, tax: 1004 }, { rate: 0.08, reduced: true, base: 1500, tax: 120 }, { rate: 0.01, reduced: true, base: 2000, tax: 20 }],
  lines: [
    { description: "CRO261003-1 プレートA（DN2612-0001 12/20納品）", quantity: 10, unit_price: 1000, amount: 10000, tax_rate: 0.1, is_reduced: false },
    { description: "CRO261003-2 B軽減（DN2612-0001 12/20納品）", quantity: 3, unit_price: 500, amount: 1500, tax_rate: 0.08, is_reduced: true },
    { description: "CRO261003-2 B軽減（DN2701-0001 01/10納品）", quantity: 4, unit_price: 500, amount: 2000, tax_rate: 0.01, is_reduced: true },
  ],
} as never;
const quote = { ...(invoice as object), doc_type: "quote", doc_no: "CRO261003", title: "混在税率", notes: "納期は発注後2週間です。\n支払条件: 月末締め翌月末払い", due_date: "2027-02-28",
  lines: [{ product_no: "CRO261003-1", name: "A標準", spec: "SKD11 t10 100x200 熱処理あり", quantity: 10, unit: "個", unit_price: 1000, amount: 10000, tax_rate: 0.1, is_reduced: false }] } as never;
const note = { doc_type: "delivery_note", doc_no: "DN2610-0002", doc_date: "2026-10-10", title: "金型部品", customer_po_no: "PO-9", issuer, customer, subtotal: 16000,
  lines: [{ product_no: "CRO261002-1", name: "金型部品X", quantity: 2, unit: "個", unit_price: 8000, amount: 16000, tax_rate: 0.1, is_reduced: false }] } as never;

const text = (bytes: Uint8Array, raw = false) => {
  const dir = mkdtempSync(join(tmpdir(), "pdf-")); writeFileSync(join(dir, "t.pdf"), bytes);
  const r = spawnSync("pdftotext", [raw ? "-raw" : "-layout", join(dir, "t.pdf"), "-"], { encoding: "utf8" });
  return { dir, out: r.status === 0 ? r.stdout : null };
};
const hasPoppler = spawnSync("pdftotext", ["-v"]).error === undefined;

test("請求書: 日本語・税率別の内訳が入り、同じ内容なら毎回同じバイト列になる", async () => {
  const a = await makeDocPdf(invoice, meta, font), b = await makeDocPdf(invoice, meta, font);
  assert.equal(createHash("sha256").update(a.bytes).digest("hex"), createHash("sha256").update(b.bytes).digest("hex"));
  assert.deepEqual(a.missing, []);
  assert.ok(a.bytes.length < 200_000, `サイズ ${a.bytes.length}`); // 部分埋め込みで小さい
  assert.equal(new TextDecoder("latin1").decode(a.bytes.slice(0, 5)), "%PDF-");
  if (hasPoppler) {
    const { out } = text(a.bytes);
    for (const s of ["請 求 書", "株式会社髙橋精機 御中", "〒210-0001 神奈川県川崎市1-1", "購買部 山田 様", "ご請求金額 ¥14,689（税込）", "10%対象", "8%対象（※軽減税率） ¥1,500", "1%対象（※軽減税率） ¥2,000", "合計 ¥14,689", "お振込先", "登録番号 T1234567890123", "発行 2026-10-31 10:23", "※は軽減税率の対象品目です"]) {
      assert.ok(out!.replace(/[ 　]+/g, " ").includes(s.replace(/[ 　]+/g, " ")), `見つからない: ${s}\n${out}`);
    }
  }
});

test("内容が変われば別のPDF。見積書（備考・仕様）・納品書・控え・取消", async () => {
  const q = await makeDocPdf(quote, meta, font);
  const n = await makeDocPdf(note, meta, font);
  const copy = await makeDocPdf({ ...(invoice as object), official: false, mf_invoice_no: "MF-1" } as never, meta, font);
  const v = await makeDocPdf(invoice, { ...meta, voided: true, void_reason: "テスト" }, font);
  const h = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
  assert.equal(new Set([q, n, copy, v].map((r) => h(r.bytes))).size, 4);
  if (hasPoppler) {
    assert.ok(text(q.bytes).out!.includes("お見積金額 ¥14,689（税込）") && text(q.bytes).out!.includes("支払条件: 月末締め翌月末払い") && text(q.bytes).out!.includes("SKD11 t10"));
    const t = text(n.bytes).out!;
    assert.ok(t.includes("客先注文番号: PO-9") && t.includes("小計（税抜） ¥16,000") && !t.includes("税率"));
    assert.ok(text(copy.bytes).out!.includes("【ERP控え・社内用】") && text(copy.bytes).out!.includes("MF-1"));
    assert.ok(text(v.bytes, true).out!.includes("取消済み")); // 回転した文字は -raw で取り出す
  }
});

test("明細が多いと複数ページになり、フォントが埋め込まれ、表示できない文字は報告される", async () => {
  const many = { ...(invoice as object), lines: Array.from({ length: 70 }, (_, i) => ({ description: `明細 ${i + 1} ` + "あ".repeat(12), quantity: 1, unit_price: 100, amount: 100, tax_rate: 0.1, is_reduced: false })) } as never;
  const r = await makeDocPdf(many, meta, font);
  const emoji = await makeDocPdf({ ...(invoice as object), customer: { ...customer, name: "テスト😀商事" } } as never, meta, font);
  assert.deepEqual(emoji.missing, ["😀"]);
  if (hasPoppler) {
    const { dir } = text(r.bytes);
    const info = spawnSync("pdfinfo", [join(dir, "t.pdf")], { encoding: "utf8" }).stdout;
    assert.match(info, /Pages:\s+[2-9]/); // 70行は複数ページ
    assert.match(info, /Title:\s+請求書 INV2610-0001（版2）/);
    const fonts = spawnSync("pdffonts", [join(dir, "t.pdf")], { encoding: "utf8" }).stdout;
    assert.match(fonts, /CrosstechSansJP/);
    assert.match(fonts, /CID TrueType\s+Identity-H\s+yes/); // 埋め込み済み（部分埋め込みは、サイズが小さいことで確認）
    assert.ok(r.bytes.length < 300_000, `サイズ ${r.bytes.length}`);
  }
});

test("宛先の項目を表示しない設定のとき、住所・部署・担当者はPDFに出ない（会社名だけ）", async () => {
  const hidden = { ...(invoice as object), customer: { id: "c1", name: "株式会社髙橋精機", postal_code: null, address: null, department: null, contact_name: null } } as never;
  const r = await makeDocPdf(hidden, meta, font);
  if (hasPoppler) {
    const t = text(r.bytes).out!;
    assert.ok(t.includes("株式会社髙橋精機 御中") && !t.includes("神奈川") && !t.includes("購買部") && !t.includes("山田") && !t.includes("様"));
  }
});

test("ファイル名・日本時間", () => {
  assert.equal(pdfFileName({ doc_date: "2026-10-31", doc_no: "INV2610-0001", customer: { name: "A/B:商事" } } as never, 2, 14689), "2026-10-31_14689_A_B_商事_INV2610-0001_v2.pdf");
  assert.equal(jst("2026-10-31T15:30:00Z"), "2026-11-01 00:30");
});
