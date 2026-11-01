import { useState } from "react";
import { supabase } from "../lib/supabase";
import { type Cell, toCsv } from "../lib/csv";
import { saveBlob } from "../lib/download";
import { ACCT_PAYMENTS_COLS, ACCT_SALES_COLS, type Col, rowsOf } from "../lib/exportColumns";

type Row = Record<string, unknown>;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

/** 税理士へ渡す会計データ（売上＝請求書×税率ごと、入金）。金額はDBの保存値をそのまま出す。特定の会計ソフト（弥生会計など）の取込形式は、見本を入手してから別に作る。 */
export function AccountingExport() {
  const [f, setF] = useState({ from: "", to: "", voided: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function fetchAll(view: string, dateCol: string, voidFilter: [string, unknown]): Promise<Row[]> {
    const out: Row[] = [];
    for (let from = 0; ; from += 1000) {
      let q = supabase.from(view).select("*").order(dateCol).order(view === "v_acct_sales" ? "invoice_no" : "payment_id").range(from, from + 999);
      if (f.from) q = q.gte(dateCol, f.from);
      if (f.to) q = q.lte(dateCol, f.to);
      if (!f.voided) q = q.eq(voidFilter[0], voidFilter[1]);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      out.push(...(data as Row[]));
      if ((data?.length ?? 0) < 1000) return out;
    }
  }
  const go = (view: string, dateCol: string, voidFilter: [string, unknown], cols: Col[], name: string) => async () => {
    setBusy(true); setMsg(null);
    try {
      const data = await fetchAll(view, dateCol, voidFilter);
      const { headers, rows } = rowsOf(cols, data);
      saveBlob(toCsv(headers, rows as Cell[][]), `${name}_${stamp()}.csv`, "text/csv;charset=utf-8");
      setMsg(`${name}: ${data.length}行を出力しました`);
    } catch (e) { setMsg(`失敗しました: ${e instanceof Error ? e.message : String(e)}`); }
    setBusy(false);
  };

  return (
    <div className="card stack">
      <h3>税理士へ渡すデータ（売上・入金）</h3>
      <p className="inactive">売上は、発行済みの請求書を<strong>税率ごとに1行</strong>で出します（消費税は請求書の保存値のまま。下書きは含みません）。入金は、消込先の請求書番号つきで1入金1行です。弥生会計の取込形式は、税理士から見本をいただいてから追加します。</p>
      <div className="grid">
        <label>から（売上は請求日、入金は入金日）<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>まで<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.voided} onChange={(e) => setF({ ...f, voided: e.target.checked })} /> 取消済みも含める（状態の列で区別できます）</label>
      </div>
      <div className="row">
        <button disabled={busy} onClick={go("v_acct_sales", "issue_date", ["status", "issued"], ACCT_SALES_COLS, "売上一覧")}>売上CSV</button>
        <button disabled={busy} onClick={go("v_acct_payments", "received_on", ["voided", false], ACCT_PAYMENTS_COLS, "入金一覧")}>入金CSV</button>
      </div>
      {msg && <p>{msg}</p>}
    </div>
  );
}
