// 実行: node --experimental-strip-types --test web/src/lib/juchu.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { juchuState, summarize } from "./juchu.ts";

test("加工状況の表示", () => {
  assert.deepEqual(juchuState(null, null, null), { label: "未同期", tone: "none" });
  assert.deepEqual(juchuState(null, null, "2026-11-01T00:00:00Z"), { label: "加工中・未完了", tone: "wip" });
  assert.deepEqual(juchuState("2026-10-30T16:00:00Z", null, "2026-11-01T00:00:00Z"), { label: "加工完了 2026-10-31", tone: "done" }); // 日本時間の暦日
  assert.deepEqual(juchuState("1970-01-01T00:00:00.000Z", null, "2026-11-01T00:00:00Z"), { label: "加工完了", tone: "done" });
  assert.deepEqual(juchuState("2026-10-30T16:00:00Z", "2026-11-02", "2026-11-03T00:00:00Z"), { label: "出荷済 2026-11-02", tone: "shipped" });
});

test("同期結果の説明", () => {
  assert.equal(summarize({ synced_at: "", matched: 5, updated: 2, failed: 0, not_in_erp: [], not_in_juchu: [] }), "受注側と一致 5件 ／ 更新 2件");
  assert.equal(summarize({ synced_at: "", matched: 5, updated: 1, failed: 1, not_in_erp: ["A"], not_in_juchu: ["B", "C"] }),
    "受注側と一致 5件 ／ 更新 1件 ／ 更新できず 1件 ／ 受注側にだけある製番 1件 ／ ERPにだけある製番 2件");
});
