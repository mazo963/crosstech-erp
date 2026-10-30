// 実行: node --experimental-strip-types --test supabase/functions/juchu-sync/logic.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRecords, planUpdates, toDate, toIso } from "./logic.ts";

test("日付変換: ISO・スラッシュ・ミリ秒・不正値", () => {
  assert.equal(toDate("2026/10/05"), "2026-10-05");
  assert.equal(toDate("2026-10-05T16:00:00Z"), "2026-10-06"); // JST換算
  assert.equal(toDate("abc"), null);
  assert.equal(toIso(Date.UTC(2026, 9, 5)), "2026-10-05T00:00:00.000Z");
  assert.equal(toIso(""), null);
});

test("抽出: item優先・親にフォールバック・製番なしは無視・配列以外は例外", () => {
  const recs = extractRecords([
    { isCompleted: true, completedAt: "2026-10-05T01:00:00Z", items: [
      { productNo: "CRO261001-1" },
      { productNo: "CRO261001-2", isCompleted: false, shippedDate: "2026-10-09" },
      { name: "製番なし" },
    ] },
  ]);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].completedAt, "2026-10-05T01:00:00.000Z");
  assert.equal(recs[1].completedAt, null);
  assert.equal(recs[1].shippedDate, "2026-10-09");
  assert.equal(extractRecords({ orders: [] }).length, 0);
  assert.throws(() => extractRecords({ foo: 1 }));
});

test("更新計画: 変化分のみ、未一致を報告、受注側に無い品目は触らない", () => {
  const records = [
    { productNo: "A", completedAt: "2026-10-05T01:00:00.000Z", shippedDate: null },
    { productNo: "B", completedAt: null, shippedDate: "2026-10-09" },
    { productNo: "Z", completedAt: null, shippedDate: null },
  ];
  const db = [
    { id: "1", product_no: "A", juchu_completed_at: "2026-10-05T10:00:00+09:00", juchu_shipped_date: null }, // 同一時刻
    { id: "2", product_no: "B", juchu_completed_at: null, juchu_shipped_date: null },
    { id: "3", product_no: "C", juchu_completed_at: null, juchu_shipped_date: null },
  ];
  const p = planUpdates(records, db);
  assert.deepEqual(p.updates.map((u) => u.id), ["2"]);
  assert.deepEqual(p.matchedIds, ["1", "2"]);
  assert.equal(p.notInErp, 1);
  assert.deepEqual(p.notInJuchu, ["C"]);
});
