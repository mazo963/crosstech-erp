// 実行: node --experimental-strip-types --test web/src/lib/mail.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxMail, cleanAddrs, customerAddrs, customerMail, mailto } from "./mail.ts";

const c = { doc_type: "invoice", doc_no: "INV2610-0001", doc_date: "2026-10-31", title: "プレート加工", due_date: "2026-11-30",
  issuer: { company_name: "株式会社クロステック" }, customer: { name: "株式会社テスト精機" } } as never;

test("宛先の整形と、書類ごとの宛先の選び方", () => {
  assert.equal(cleanAddrs(" a@x.jp; b@x.jp、c@x.jp  d@x.jp "), "a@x.jp,b@x.jp,c@x.jp,d@x.jp");
  const m = { invoice_mail_to: "inv@x.jp", invoice_mail_cc: "icc@x.jp", delivery_mail_to: null, delivery_mail_cc: "" };
  assert.deepEqual(customerAddrs("invoice", m), { to: "inv@x.jp", cc: "icc@x.jp" });
  assert.deepEqual(customerAddrs("delivery_note", m), { to: "inv@x.jp", cc: "icc@x.jp" }); // 納品書用が空なら請求書用
  assert.deepEqual(customerAddrs("quote", { ...m, delivery_mail_to: "del@x.jp" }), { to: "del@x.jp", cc: "icc@x.jp" });
});

test("mailto: 宛先・CC・件名・本文（改行はCRLF）が正しく符号化される", () => {
  const { subject, body } = customerMail(c, 14665, "2026-10-31_14665_株式会社テスト精機_INV2610-0001_v1.pdf", "署名の行\n電話 03-0000-0000");
  const url = mailto("a@x.jp,b+c@x.jp", { cc: "cc@x.jp", subject, body });
  assert.ok(url.startsWith("mailto:a%40x.jp,b%2Bc%40x.jp?cc=cc%40x.jp&subject="));
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("subject"), "【請求書】INV2610-0001／株式会社クロステック");
  const text = q.get("body")!;
  assert.ok(text.includes("株式会社テスト精機 御中\r\n") && text.includes("・金額: ¥14,665（税込）") && text.includes("・お支払期日: 2026-11-30") && text.includes("署名の行\r\n電話 03-0000-0000"));
  assert.ok(url.length < 1800, `長さ ${url.length}`);
});

test("Box宛のメール: 件名にPDFの名前、本文に同じPDFを添付する注意", () => {
  const b = boxMail(c, 14665, "x.pdf");
  assert.equal(b.subject, "【Box保存】x.pdf");
  assert.ok(b.body.includes("同じPDFを添付"));
  const n = customerMail({ ...(c as object), doc_type: "delivery_note", doc_no: "DN2610-0001" } as never, 16000, "d.pdf", null);
  assert.ok(n.body.includes("（税抜）") && n.body.trimEnd().endsWith("株式会社クロステック")); // 署名が空なら会社名
});
