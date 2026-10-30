// Deno・Supabase に依存しない純粋ロジック（Node でも単体テストできる）。
import type { Draft } from "./schema.ts";

export type SourceType = "email" | "po_pdf";

export type Config = {
  modelDefault: string;
  modelAdvanced: string;
  monthlyLimit: number;
};

/** 既定は Haiku、PDF または advanced 指定のときだけ Sonnet。 */
export function pickModel(cfg: Config, source: SourceType, advanced: boolean): string {
  return source === "po_pdf" || advanced ? cfg.modelAdvanced : cfg.modelDefault;
}

export function monthStartIso(now: Date): string {
  // 月の区切りは日本時間（JST = UTC+9）
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const start = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - 9 * 3600_000;
  return new Date(start).toISOString();
}

export function isOverLimit(used: number, limit: number): boolean {
  return limit > 0 && used >= limit;
}

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** AIの返り値を検証・整形する。不正な日付は null に落とし、必須が欠けたら例外。 */
export function normalizeDraft(raw: unknown): Draft {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("抽出結果がオブジェクトではありません");
  if (typeof r.title !== "string" || !r.title.trim()) throw new Error("title がありません");
  if (!Array.isArray(r.items) || r.items.length === 0) throw new Error("品目が抽出できませんでした");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const items = r.items.map((it, i) => {
    const x = it as Record<string, unknown>;
    const name = str(x.name);
    const quantity = Number(x.quantity);
    if (!name) throw new Error(`品目${i + 1}: 品名がありません`);
    if (!(quantity > 0)) throw new Error(`品目${i + 1}: 数量が不正です`);
    const price = x.sale_unit_price == null ? null : Number(x.sale_unit_price);
    return {
      name,
      customer_part_no: str(x.customer_part_no),
      spec: str(x.spec),
      quantity,
      unit: str(x.unit),
      sale_unit_price: price != null && price >= 0 ? price : null,
      due_date: isDate(x.due_date) ? (x.due_date as string) : null,
    };
  });
  return {
    customer_name: str(r.customer_name),
    contact_name: str(r.contact_name),
    title: r.title.trim(),
    customer_po_no: str(r.customer_po_no),
    due_date: isDate(r.due_date) ? (r.due_date as string) : null,
    notes: str(r.notes),
    internal_memo: str(r.internal_memo),
    items,
  };
}

const norm = (s: string) =>
  s.normalize("NFKC").toLowerCase()
    .replace(/(株式会社|有限会社|合同会社|\(株\)|（株）|㈱|\(有\)|（有）)/g, "")
    .replace(/[\s　・.,，、。\-ー]/g, "");

export type CustomerRow = { id: string; name: string; name_kana: string | null };

/** 会社名の部分一致で候補を最大5件。自動確定はしない。 */
export function matchCustomers(name: string | null, customers: CustomerRow[]): CustomerRow[] {
  if (!name) return [];
  const q = norm(name);
  if (!q) return [];
  return customers
    .filter((c) => {
      const n = norm(c.name);
      const k = c.name_kana ? norm(c.name_kana) : "";
      if (!n) return false;
      return n.includes(q) || q.includes(n) || (k !== "" && (k.includes(q) || q.includes(k)));
    })
    .slice(0, 5);
}
