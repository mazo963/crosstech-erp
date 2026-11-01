// 出力CSVの列定義（見出しは日本語）。値はDBの出力ビュー（v_export_*）の列。
import type { Cell } from "./csv";

export type Col = [header: string, key: string, map?: (v: unknown) => Cell];
type Dict = Record<string, string>;
const via = (d: Dict) => (v: unknown) => d[String(v)] ?? (v as Cell);

const KIND = via({ electronic: "電子取引", scanned: "スキャナ保存" });
const CATEGORY = via({ invoice: "請求書", receipt: "領収書", delivery_note: "納品書", quote: "見積書", order: "注文書", contract: "契約書", other: "その他" });
const IMPORTANCE = via({ important: "重要書類", general: "一般書類" });
const CHANNEL = via({ email: "メール", web: "Webサイト・クラウド", edi: "EDI", cloud: "クラウドサービス", post: "郵送", hand: "手渡し", other: "その他" });
const COLOR = via({ color: "カラー", grayscale: "グレースケール", mono: "白黒2値" });
const TIMELY = via({ early: "7営業日以内", cycle: "2か月+7営業日以内", late: "期限超過" });
const TS = via({ stamped: "付与済み", stamped_late: "付与済み（期限後）", pending: "付与待ち", overdue: "期限超過（未付与）", external: "自社では付与しない（Box等で保存）" });
const DOC = via({ quote: "見積書", delivery_note: "納品書", invoice: "請求書" });
const METHOD = via({ paper: "紙", email_pdf: "PDF（メール等）", box: "Box保存", other: "その他" });

export const RECEIVED_COLS: Col[] = [
  ["登録ID", "id"], ["保存の種類", "kind", KIND], ["書類の種類", "doc_category", CATEGORY], ["書類の区分", "importance", IMPORTANCE],
  ["取引年月日", "doc_date"], ["取引金額（円）", "amount"], ["取引先", "counterparty_name"],
  ["関連する伝票番号", "related_ref"], ["帳簿への紐づけ", "link_refs"],
  ["授受日", "received_on"], ["受け取った方法", "channel", CHANNEL], ["ファイル名", "file_name"], ["ファイル形式", "mime_type"],
  ["サイズ（バイト）", "size_bytes"], ["SHA-256", "sha256"],
  ["読取日", "scanned_on"], ["解像度（dpi）", "resolution_dpi"], ["色", "color_mode", COLOR], ["用紙サイズ", "page_size"], ["ページ数", "page_count"],
  ["入力期限（7営業日）", "deadline_early"], ["入力期限（最長）", "deadline_max"], ["入力期限の判定", "input_timeliness", TIMELY],
  ["紙の原本の保存が必要", "paper_original_required"],
  ["登録日", "registered_on"], ["登録日時", "registered_at"], ["登録者", "registered_by_name"],
  ["取消", "voided"], ["取消の理由", "void_reason"], ["取消日時", "voided_at"],
  ["タイムスタンプの状況", "timestamp_status", TS], ["タイムスタンプの付与時刻", "timestamp_first_time"],
  ["タイムスタンプの件数", "timestamp_count"], ["時刻認証局", "timestamp_tsa"],
];

export const ISSUED_COLS: Col[] = [
  ["帳票ID", "id"], ["種類", "doc_type", DOC], ["帳票番号", "doc_no"], ["版", "version"],
  ["取引年月日", "doc_date"], ["取引金額（円）", "amount"], ["取引先", "counterparty_name"],
  ["内容のSHA-256", "content_sha256"], ["交付の記録", "deliveries"], ["送付PDFの件数", "sent_pdf_count"],
  ["発行日時", "issued_at"], ["発行者", "issued_by_name"], ["取消", "voided"], ["取消の理由", "void_reason"], ["取消日時", "voided_at"],
];

export const SENT_COLS: Col[] = [
  ["PDFのID", "id"], ["帳票ID", "document_id"], ["種類", "doc_type", DOC], ["帳票番号", "doc_no"], ["版", "version"],
  ["取引年月日", "doc_date"], ["取引金額（円）", "amount"], ["取引先", "counterparty_name"],
  ["ファイル名", "file_name"], ["サイズ（バイト）", "size_bytes"], ["SHA-256", "sha256"], ["保存日時", "uploaded_at"],
  ["交付日", "delivered_on"], ["交付方法", "delivery_method", METHOD], ["宛先", "recipient"], ["帳票の取消", "voided"],
  ["タイムスタンプの状況", "timestamp_status", TS], ["タイムスタンプの付与時刻", "timestamp_first_time"],
  ["タイムスタンプの件数", "timestamp_count"], ["時刻認証局", "timestamp_tsa"],
];

export function rowsOf(cols: Col[], data: Record<string, unknown>[]): { headers: string[]; rows: Cell[][] } {
  return {
    headers: cols.map((c) => c[0]),
    rows: data.map((r) => cols.map(([, key, map]) => (map ? map(r[key]) : (r[key] as Cell)))),
  };
}

/** ファイル名に使えない文字を除く（日本語は残す）。長すぎる場合は切り詰める。 */
export function safeName(s: string, max = 80): string {
  const t = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "_");
  return Array.from(t).slice(0, max).join("") || "_";
}

/** 同じパスが重なったら、末尾に連番を付ける。 */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Map<string, number>();
  return paths.map((p) => {
    const n = (seen.get(p) ?? 0) + 1;
    seen.set(p, n);
    if (n === 1) return p;
    const dot = p.lastIndexOf(".");
    return dot > p.lastIndexOf("/") ? `${p.slice(0, dot)}_${n}${p.slice(dot)}` : `${p}_${n}`;
  });
}

// ---- 税理士へ渡す会計データ（v_acct_sales / v_acct_payments）。特定の会計ソフトの形式ではない ----
const STATUS = via({ issued: "発行済み", void: "取消済み" });
const PAY_METHOD = via({ bank: "銀行振込", cash: "現金", offset: "相殺", other: "その他" });

export const ACCT_SALES_COLS: Col[] = [
  ["請求日", "issue_date"], ["請求書番号", "invoice_no"], ["得意先コード", "customer_code"], ["得意先", "customer_name"],
  ["得意先の登録番号", "customer_invoice_reg_no"], ["税率", "tax_rate", (v) => (v == null ? "" : `${Math.round(Number(v) * 10000) / 100}%`)],
  ["軽減税率", "is_reduced"], ["課税対象額（税抜・円）", "taxable_amount"], ["消費税額（円）", "tax_amount"], ["税込合計（円）", "gross_amount"],
  ["請求書の税抜小計（円）", "invoice_subtotal"], ["請求書の消費税合計（円）", "invoice_tax"], ["請求書の合計（円）", "invoice_total"],
  ["対象期間（から）", "period_from"], ["対象期間（まで）", "period_to"], ["支払期日", "due_date"],
  ["状態", "status", STATUS], ["送付PDFのファイル名（Box）", "sent_pdf_file_name"],
];

export const ACCT_PAYMENTS_COLS: Col[] = [
  ["入金日", "received_on"], ["得意先コード", "customer_code"], ["得意先", "customer_name"],
  ["入金額（円）", "amount"], ["振込手数料（先方差引・円）", "fee"], ["消込額（円）", "cleared_amount"],
  ["方法", "method", PAY_METHOD], ["入金銀行", "bank_name"], ["口座番号", "account_no"], ["消込先の請求書", "allocated_invoices"],
  ["メモ", "memo"], ["取消", "voided"], ["取消の理由", "void_reason"],
];
