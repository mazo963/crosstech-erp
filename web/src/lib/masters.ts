// マスタ画面の項目定義。DBの制約（check）と同じ選択肢にしてある。
export type Field = {
  key: string;
  label: string;
  type?: "text" | "textarea" | "select" | "email";
  options?: [string, string][]; // [値, 表示]
  numeric?: boolean;
  required?: boolean;
  list?: boolean; // 一覧に出す
  pattern?: string;
  hint?: string;
};

export type MasterDef = { table: string; title: string; fields: Field[] };

const dayOptions: [string, string][] = [
  ["5", "5日"], ["10", "10日"], ["15", "15日"], ["20", "20日"], ["25", "25日"], ["31", "末日"],
];
const payDayOptions: [string, string][] = [["0", "即日"], ...dayOptions];

export const customers: MasterDef = {
  table: "customers",
  title: "得意先",
  fields: [
    { key: "code", label: "コード", list: true },
    { key: "name", label: "会社名", required: true, list: true },
    { key: "name_kana", label: "フリガナ" },
    { key: "contact_name", label: "担当者", list: true },
    { key: "postal_code", label: "郵便番号" },
    { key: "address", label: "住所" },
    { key: "tel", label: "電話", list: true },
    { key: "invoice_reg_no", label: "適格請求書発行事業者番号", pattern: "T[0-9]{13}", hint: "T + 数字13桁" },
    { key: "closing_day", label: "締め日", type: "select", numeric: true, options: dayOptions, required: true },
    { key: "payment_month_offset", label: "支払月", type: "select", numeric: true, required: true,
      options: [["0", "当月"], ["1", "翌月"], ["2", "翌々月"], ["3", "3か月後"]] },
    { key: "payment_day", label: "支払日", type: "select", numeric: true, options: payDayOptions, required: true },
    { key: "billing_basis", label: "請求の基準", type: "select", required: true,
      options: [["per_delivery", "納品ごと"], ["on_completion", "全納完了時"]] },
    { key: "invoice_mail_to", label: "請求書メール TO", type: "email" },
    { key: "invoice_mail_cc", label: "請求書メール CC" },
    { key: "delivery_mail_to", label: "納品書メール TO", type: "email" },
    { key: "delivery_mail_cc", label: "納品書メール CC" },
    { key: "notes", label: "備考", type: "textarea" },
  ],
};

export const vendors: MasterDef = {
  table: "vendors",
  title: "外注先",
  fields: [
    { key: "name", label: "会社名", required: true, list: true },
    { key: "contact_name", label: "担当者", list: true },
    { key: "tel", label: "電話", list: true },
    { key: "email", label: "メール", type: "email" },
    { key: "closing_day", label: "締め日", type: "select", numeric: true, options: dayOptions, required: true },
    { key: "process_types", label: "対応工程", list: true, hint: "例: 表面処理, 熱処理, 追加工" },
    { key: "notes", label: "備考", type: "textarea" },
  ],
};
