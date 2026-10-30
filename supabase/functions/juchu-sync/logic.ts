// Deno・Supabase に依存しない純粋ロジック（Node でも単体テストできる）。
// 受注GASの doGet が返す JSON から、製番ごとの加工完了・出荷日を取り出す。
// 項目名は仕様書 §10 のデータ契約: items[].productNo / isCompleted / completedAt / shippedDate
// ※完了・出荷の項目が item 側か受注（親）側かは実データで未確認のため、item を優先し親にも対応する。

export type JuchuRecord = {
  productNo: string;
  completedAt: string | null; // ISO8601
  shippedDate: string | null; // YYYY-MM-DD
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function pick(item: Obj, order: Obj, key: string): unknown {
  return item[key] !== undefined ? item[key] : order[key];
}

/** 日時を ISO8601 に。文字列・ミリ秒数値に対応。解釈できなければ null。 */
export function toIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 日付を YYYY-MM-DD（日本時間の暦日）に。解釈できなければ null。 */
export function toDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const iso = toIso(typeof v === "string" ? v.replace(/\//g, "-") : v);
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 受注JSON（配列、または { orders|data|items: 配列 }）から製番単位のレコードを作る。 */
export function extractRecords(json: unknown): JuchuRecord[] {
  const orders = Array.isArray(json)
    ? json
    : isObj(json)
    ? (["orders", "data", "items"].map((k) => json[k]).find(Array.isArray) as unknown[] | undefined)
    : undefined;
  if (!orders) throw new Error("受注JSONの形式が想定と違います（配列ではありません）");
  const out = new Map<string, JuchuRecord>();
  for (const order of orders) {
    if (!isObj(order) || !Array.isArray(order.items)) continue;
    for (const item of order.items) {
      if (!isObj(item)) continue;
      const productNo = typeof item.productNo === "string" ? item.productNo.trim() : "";
      if (!productNo) continue;
      const completed = pick(item, order, "isCompleted") === true;
      out.set(productNo, {
        productNo,
        completedAt: completed ? toIso(pick(item, order, "completedAt")) ?? new Date(0).toISOString() : null,
        shippedDate: toDate(pick(item, order, "shippedDate")),
      });
    }
  }
  return [...out.values()];
}

export type DbItem = {
  id: string;
  product_no: string;
  juchu_completed_at: string | null;
  juchu_shipped_date: string | null;
};

export type Update = { id: string; juchu_completed_at: string | null; juchu_shipped_date: string | null };

/** 照合して、値が変わる品目だけ更新対象にする。受注側に無いERP品目は触らない。 */
export function planUpdates(records: JuchuRecord[], dbItems: DbItem[]) {
  const byNo = new Map(records.map((r) => [r.productNo, r]));
  const updates: Update[] = [];
  const matched = new Set<string>();
  for (const it of dbItems) {
    const r = byNo.get(it.product_no);
    if (!r) continue;
    matched.add(it.product_no);
    const sameAt = (it.juchu_completed_at ? new Date(it.juchu_completed_at).getTime() : null) ===
      (r.completedAt ? new Date(r.completedAt).getTime() : null);
    if (!sameAt || it.juchu_shipped_date !== r.shippedDate) {
      updates.push({ id: it.id, juchu_completed_at: r.completedAt, juchu_shipped_date: r.shippedDate });
    }
  }
  const notInErp = records.filter((r) => !dbItems.some((i) => i.product_no === r.productNo)).length;
  const notInJuchu = dbItems.filter((i) => !byNo.has(i.product_no)).map((i) => i.product_no);
  return { updates, matchedIds: dbItems.filter((i) => matched.has(i.product_no)).map((i) => i.id), notInErp, notInJuchu };
}
