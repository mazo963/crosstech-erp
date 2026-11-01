// 実行: node --experimental-strip-types --test web/src/lib/accountingColumns.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCT_PAYMENTS_COLS, ACCT_SALES_COLS, rowsOf } from "./exportColumns.ts";
import { toCsv } from "./csv.ts";

test("売上CSV: 税率別の行、見出しと値の対応、税率の表示", () => {
  const { headers, rows } = rowsOf(ACCT_SALES_COLS, [{ issue_date: "2026-12-02", invoice_no: "INV2612-0001", customer_code: "A001", customer_name: "会計商事", tax_rate: 0.08, is_reduced: true, taxable_amount: 1500, tax_amount: 120, gross_amount: 1620, status: "issued", sent_pdf_file_name: "x.pdf" }]);
  assert.equal(headers.length, ACCT_SALES_COLS.length);
  const o = Object.fromEntries(headers.map((h, i) => [h, rows[0][i]]));
  assert.equal(o["税率"], "8%"); assert.equal(o["課税対象額（税抜・円）"], 1500); assert.equal(o["消費税額（円）"], 120); assert.equal(o["状態"], "発行済み"); assert.equal(o["軽減税率"], true);
});

test("入金CSV: 方法・取消の表示、Excelで開けるCSV（BOM・CRLF・式の無効化）", () => {
  const { headers, rows } = rowsOf(ACCT_PAYMENTS_COLS, [{ received_on: "2026-12-20", customer_name: "=危険", amount: 10000, fee: 330, cleared_amount: 10330, method: "bank", bank_name: "A銀行", allocated_invoices: "INV2612-0001（10330円）", voided: false }]);
  const csv = toCsv(headers, rows as never);
  assert.ok(csv.startsWith("﻿入金日,")); assert.ok(csv.includes("\r\n"));
  assert.ok(csv.includes("銀行振込")); assert.ok(csv.includes("'=危険")); assert.ok(csv.includes("いいえ"));
});
