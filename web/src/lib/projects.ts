// 案件画面の型と、入力値 → DB送信値の変換。金額の計算はしない（DBの view が行う）。
export type ItemForm = {
  id?: string;
  product_no: string;
  customer_part_no: string;
  name: string;
  spec: string;
  quantity: string;
  unit: string;
  sale_unit_price: string;
  cost_unit_price: string;
  vendor_id: string;
  due_date: string;
  tax_category: string;
};

export type HeadForm = {
  customer_id: string;
  lead_staff_id: string;
  title: string;
  customer_po_no: string;
  status: string;
  estimate_date: string;
  order_date: string;
  due_date: string;
  notes: string;
  internal_memo: string;
};

export const STATUS: [string, string][] = [
  ["estimate", "見積中"], ["ordered", "受注"], ["lost", "失注"], ["closed", "完了"],
];

export const emptyItem = (): ItemForm => ({
  product_no: "", customer_part_no: "", name: "", spec: "", quantity: "1", unit: "個",
  sale_unit_price: "0", cost_unit_price: "0", vendor_id: "", due_date: "", tax_category: "standard",
});

export const emptyHead = (leadStaffId = ""): HeadForm => ({
  customer_id: "", lead_staff_id: leadStaffId, title: "", customer_po_no: "", status: "estimate",
  estimate_date: new Date().toISOString().slice(0, 10), order_date: "", due_date: "", notes: "", internal_memo: "",
});

const nul = (v: string) => (v.trim() === "" ? null : v.trim());

export function headPayload(h: HeadForm) {
  return {
    customer_id: h.customer_id, lead_staff_id: nul(h.lead_staff_id), title: h.title.trim(),
    customer_po_no: nul(h.customer_po_no), status: h.status, estimate_date: nul(h.estimate_date),
    order_date: nul(h.order_date), due_date: nul(h.due_date), notes: nul(h.notes), internal_memo: nul(h.internal_memo),
  };
}

/** product_no が空ならキーごと送らず、DB（トリガー）に自動採番させる。 */
export function itemPayload(it: ItemForm) {
  return {
    ...(it.product_no.trim() ? { product_no: it.product_no.trim() } : {}),
    customer_part_no: nul(it.customer_part_no), name: it.name.trim(), spec: nul(it.spec),
    quantity: Number(it.quantity), unit: it.unit.trim() || "個",
    sale_unit_price: Number(it.sale_unit_price || 0), cost_unit_price: Number(it.cost_unit_price || 0),
    vendor_id: nul(it.vendor_id), due_date: nul(it.due_date), tax_category: it.tax_category || "standard",
  };
}

export function itemFromRow(r: Record<string, unknown>): ItemForm {
  const s = (v: unknown) => (v == null ? "" : String(v));
  return {
    id: r.id as string, product_no: s(r.product_no), customer_part_no: s(r.customer_part_no), name: s(r.name),
    spec: s(r.spec), quantity: s(r.quantity), unit: s(r.unit), sale_unit_price: s(r.sale_unit_price),
    cost_unit_price: s(r.cost_unit_price), vendor_id: s(r.vendor_id), due_date: s(r.due_date),
    tax_category: s(r.tax_category) || "standard",
  };
}

export type AiDraft = {
  customer_name: string | null; title: string; customer_po_no?: string | null; due_date?: string | null;
  notes?: string | null; internal_memo?: string | null;
  items: { name: string; customer_part_no?: string | null; spec?: string | null; quantity: number; unit?: string | null;
    sale_unit_price?: number | null; due_date?: string | null }[];
};

export type AiResult = {
  extraction_id: string; model: string; draft: AiDraft;
  customer_candidates: { id: string; name: string }[];
};
