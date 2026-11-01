// 発行済み帳票（issued_documents）の型と表示用の定数。内容は発行時に固定され、画面は表示するだけ。
export type DocType = "quote" | "delivery_note" | "invoice";

export const DOC_LABEL: Record<DocType, string> = { quote: "見積書", delivery_note: "納品書", invoice: "請求書" };

export type DocLine = {
  product_no?: string | null; name?: string; description?: string; spec?: string | null;
  quantity: number; unit?: string | null; unit_price: number; amount: number; due_date?: string | null;
  tax_rate?: number; is_reduced?: boolean;
};

export type DocBank = { bank_name: string; branch_name: string | null; account_type: string; account_number: string; account_holder: string };

export type DocContent = {
  doc_type: DocType; doc_no: string; doc_date: string; title?: string; notes?: string | null; due_date?: string | null;
  project_no?: string; customer_po_no?: string | null;
  valid_until?: string | null; delivery_place?: string | null; payment_terms?: string | null; bank?: DocBank | null;
  issuer: { company_name: string; invoice_reg_no: string | null; postal_code: string | null; address: string | null; tel: string | null; email: string | null;
    fax?: string | null; contact_person?: string | null; logo?: string | null; seal?: string | null };
  customer: { id: string; name: string; postal_code: string | null; address: string | null; contact_name: string | null; department?: string | null };
  lines: DocLine[]; subtotal: number; tax?: number; total?: number;
  tax_breakdown?: { rate: number; reduced: boolean; base: number; tax: number }[];
  official?: boolean; mf_invoice_no?: string | null; bank_info?: string | null; period_from?: string | null; period_to?: string | null;
};

export type IssuedDoc = {
  id: string; doc_type: DocType; source_id: string; doc_no: string; version: number; doc_date: string; amount: number;
  counterparty_name: string; content: DocContent; content_sha256: string; voided: boolean; void_reason: string | null;
  issued_at: string;
};

/** 帳票URL（#doc=<id>）。どの画面からでも帳票を開ける。 */
export const openDocument = (id: string) => { window.location.hash = `doc=${id}`; };

/** 振込先の文章。口座の登録があればそれを、なければ従来の自由記入欄（bank_info）を使う。 */
export const bankText = (c: DocContent): string | null =>
  c.bank ? [c.bank.bank_name, c.bank.branch_name, `${c.bank.account_type} ${c.bank.account_number}`, c.bank.account_holder].filter(Boolean).join("　") : c.bank_info ?? null;

/** data URL（data:image/png;base64,...）を、種類とバイト列に分ける。形式が違えば null。 */
export function parseDataUrl(u: string | null | undefined): { type: "png" | "jpeg"; bytes: Uint8Array } | null {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(u ?? "");
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type: m[1] as "png" | "jpeg", bytes };
}
