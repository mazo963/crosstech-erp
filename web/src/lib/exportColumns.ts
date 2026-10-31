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
