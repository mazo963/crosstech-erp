// 実行: node --experimental-strip-types --test supabase/functions/ai-extract/logic.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOverLimit, matchCustomers, monthStartIso, normalizeDraft, pickModel } from "./logic.ts";
import { callAnthropic } from "./anthropic.ts";

const cfg = { modelDefault: "H", modelAdvanced: "S", monthlyLimit: 100 };

test("モデル選択: メールは既定、PDFと advanced は上位", () => {
  assert.equal(pickModel(cfg, "email", false), "H");
  assert.equal(pickModel(cfg, "email", true), "S");
  assert.equal(pickModel(cfg, "po_pdf", false), "S");
});

test("月初はJST基準", () => {
  assert.equal(monthStartIso(new Date("2026-10-31T16:00:00Z")), "2026-10-31T15:00:00.000Z"); // JST 11/1 01:00 → 11月初
  assert.equal(monthStartIso(new Date("2026-10-30T00:00:00Z")), "2026-09-30T15:00:00.000Z");
});

test("上限判定: 0は無制限", () => {
  assert.equal(isOverLimit(100, 100), true);
  assert.equal(isOverLimit(99, 100), false);
  assert.equal(isOverLimit(10 ** 9, 0), false);
});

test("normalizeDraft: 正常・不正日付・必須欠落", () => {
  const d = normalizeDraft({ customer_name: " ㈱テスト ", title: "T", due_date: "2026-13-45x",
    items: [{ name: "板", quantity: 3, sale_unit_price: -5, due_date: "2026-11-30" }] });
  assert.equal(d.due_date, null);
  assert.equal(d.items[0].sale_unit_price, null);
  assert.equal(d.items[0].due_date, "2026-11-30");
  assert.throws(() => normalizeDraft({ title: "T", items: [] }));
  assert.throws(() => normalizeDraft({ title: "T", items: [{ name: "a", quantity: 0 }] }));
});

test("得意先候補: 法人格・全半角を無視", () => {
  const cs = [{ id: "1", name: "株式会社テスト製作所", name_kana: null }, { id: "2", name: "別会社", name_kana: null }];
  assert.deepEqual(matchCustomers("(株)テスト製作所", cs).map((c) => c.id), ["1"]);
  assert.deepEqual(matchCustomers(null, cs), []);
});

test("callAnthropic: tool_use を取り出し、モデルIDは引数から渡す", async () => {
  let sent: any;
  const fake = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: "tool_use", input: { title: "x" } }], usage: { input_tokens: 7, output_tokens: 3 } }));
  }) as unknown as typeof fetch;
  const r = await callAnthropic("k", "MODEL-X", { kind: "text", text: "hi" }, "2026-10-30", fake);
  assert.equal(sent.model, "MODEL-X");
  assert.equal(sent.tool_choice.type, "tool");
  assert.deepEqual(r.usage, { input_tokens: 7, output_tokens: 3 });
});
