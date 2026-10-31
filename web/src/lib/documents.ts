// 発行済み帳票（issued_documents）の型と表示用の定数。内容は発行時に固定され、画面は表示するだけ。
export type DocType = "quote" | "delivery_note" | "invoice";

export const DOC_LABEL: Record<DocType, string> = { quote: "見積書", delivery_note: "納品書", invoice: "請求書" };

export type DocLine = {
  product_no?: string | null; name?: string; description?: string; spec?: string | null;
  quantity: number; unit?: string | null; unit_price: number; amount: number; due_date?: string | null;
  tax_rate?: number; is_reduced?: boolean;
};

export type DocContent = {
  doc_type: DocType; doc_no: string; doc_date: string; title?: string; notes?: string | null; due_date?: string | null;
  project_no?: string; customer_po_no?: string | null;
  issuer: { company_name: string; invoice_reg_no: string | null; postal_code: string | null; address: string | null; tel: string | null; email: string | null };
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
