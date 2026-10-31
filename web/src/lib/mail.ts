// メール作成（mailto）。宛先・CC・件名・本文を自動で入れる。PDFはブラウザの仕様で添付できないので、手で添付する。
import type { DocContent, DocType } from "./documents.ts";
import { DOC_LABEL } from "./documents.ts";

export type CustomerMail = { invoice_mail_to: string | null; invoice_mail_cc: string | null; delivery_mail_to: string | null; delivery_mail_cc: string | null };

/** 区切り（カンマ・セミコロン・読点・空白）を、カンマに整える。 */
export const cleanAddrs = (s: string | null | undefined) => (s ?? "").split(/[,;、；\s]+/).map((x) => x.trim()).filter(Boolean).join(",");

/** 請求書は請求書用の宛先、見積書・納品書は納品書用の宛先（無ければ請求書用）。 */
export function customerAddrs(type: DocType, c: CustomerMail): { to: string; cc: string } {
  if (type === "invoice") return { to: cleanAddrs(c.invoice_mail_to), cc: cleanAddrs(c.invoice_mail_cc) };
  return { to: cleanAddrs(c.delivery_mail_to) || cleanAddrs(c.invoice_mail_to), cc: cleanAddrs(c.delivery_mail_cc) || cleanAddrs(c.invoice_mail_cc) };
}

const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));
export function mailto(to: string, o: { cc?: string; subject: string; body: string }): string {
  const parts = [`subject=${enc(o.subject)}`, `body=${enc(o.body)}`];
  if (o.cc) parts.unshift(`cc=${o.cc.split(",").map(encodeURIComponent).join(",")}`);
  return `mailto:${to.split(",").map(encodeURIComponent).join(",")}?${parts.join("&")}`;
}

const yen = (n: number) => `¥${Number(n).toLocaleString("ja-JP")}`;

/** お客様宛のメール（件名・本文）。 */
export function customerMail(c: DocContent, amount: number, pdfName: string, signature: string | null) {
  const label = DOC_LABEL[c.doc_type];
  const company = c.issuer.company_name;
  const lines = [
    `${c.customer.name} 御中`,
    ...(c.customer.department || c.customer.contact_name ? [[c.customer.department, c.customer.contact_name && `${c.customer.contact_name} 様`].filter(Boolean).join("　")] : []), "",
    "いつもお世話になっております。", `${company}です。`,
    `${label}をお送りします。ご確認をお願いいたします。`, "",
    `・${label}番号: ${c.doc_no}`,
    ...(c.title ? [`・件名: ${c.title}`] : []),
    `・金額: ${yen(amount)}（${c.doc_type === "delivery_note" ? "税抜" : "税込"}）`,
    ...(c.doc_type === "invoice" && c.due_date ? [`・お支払期日: ${c.due_date}`] : []),
    ...(c.doc_type === "quote" && c.due_date ? [`・納期: ${c.due_date}`] : []),
    `・添付: ${pdfName}`, "",
    ...(signature?.trim() ? [signature.trim()] : [company]),
  ];
  const subject = `【${label}】${c.doc_type === "invoice" ? c.doc_no : `${c.title ? `${c.title}（${c.doc_no}）` : c.doc_no}`}／${company}`;
  return { subject, body: lines.join("\n") };
}

/** Box（メール取込）宛のメール。保存されるのは添付ファイル。宛先はBoxのアドレスだけにする。 */
export function boxMail(c: DocContent, amount: number, pdfName: string) {
  const label = DOC_LABEL[c.doc_type];
  return {
    subject: `【Box保存】${pdfName}`,
    body: [`証憑保存用（Box メール取込）`, `${label} ${c.doc_no}／${c.customer.name}／${c.doc_date}／${yen(amount)}`, `添付: ${pdfName}`, "", "※お客様に送ったものと同じPDFを添付してください。"].join("\n"),
  };
}
