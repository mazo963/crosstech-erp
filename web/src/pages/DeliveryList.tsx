import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";
import { go } from "../lib/nav";
import { openDocument } from "../lib/documents";
import { IssueButton } from "./IssueButton";

type Row = {
  id: string; delivery_no: string; delivered_on: string; voided: boolean; void_reason: string | null; project_id: string; project_no: string;
  project_title: string; customer_name: string; amount: number; invoice_id: string | null; invoice_no: string | null; invoice_status: string | null;
  doc_id: string | null; doc_version: number | null;
};

/** 納品（納品書）の一覧。請求の状況が分かり、納品1回を1枚の請求書にできる。 */
export function DeliveryList({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [f, setF] = useState({ state: "unbilled", name: "", from: "", to: "" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let q = supabase.from("v_delivery_list").select("*").order("delivered_on", { ascending: false }).order("delivery_no", { ascending: false }).limit(300);
    if (f.state === "unbilled") q = q.eq("voided", false).is("invoice_id", null);
    else if (f.state === "billed") q = q.eq("voided", false).not("invoice_id", "is", null);
    else if (f.state === "voided") q = q.eq("voided", true);
    if (f.name.trim()) q = q.ilike("customer_name", `%${f.name.trim()}%`);
    if (f.from) q = q.gte("delivered_on", f.from);
    if (f.to) q = q.lte("delivered_on", f.to);
    const { data, error } = await q;
    if (error) setError(error.message); else setRows(data as Row[]);
  }, [f]);
  useEffect(() => { load(); }, [load]);

  async function invoice(r: Row) {
    setError(null);
    const { data, error } = await supabase.rpc("create_invoice_for_delivery", { p_delivery_id: r.id });
    if (error) return setError(error.message);
    go("invoice", data as string);
  }

  return (
    <div className="card stack">
      <h3>納品</h3>
      <div className="row wrap">
        <label>請求の状況
          <select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
            <option value="unbilled">未請求</option><option value="billed">請求済み</option><option value="voided">取消</option><option value="">すべて</option>
          </select>
        </label>
        <label>得意先<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>納品日（から）<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>納品日（まで）<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
      </div>
      <p className="inactive">納品の記録・取消は、各案件の「分納」で行います。月末にまとめて請求するときは、「請求」タブの「締め請求を作成」を使います。</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>納品書番号</th><th>納品日</th><th>得意先</th><th>案件</th><th>金額（税抜）</th><th>請求</th><th>納品書</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.voided ? "inactive" : ""}>
              <td className="nowrap">{r.delivery_no}{r.voided && "（取消）"}</td><td className="nowrap">{r.delivered_on}</td><td>{r.customer_name}</td>
              <td><button className="linkbtn" onClick={() => go("project", r.project_id)}>{r.project_no} {r.project_title}</button></td>
              <td className="nowrap">{yen(r.amount)}</td>
              <td className="nowrap">{r.voided ? "-" : r.invoice_id ? <button className="linkbtn" onClick={() => go("invoice", r.invoice_id!)}>{r.invoice_no}</button> : <span className="error">未請求</span>}</td>
              <td className="nowrap">{r.doc_id ? <button className="linkbtn" onClick={() => openDocument(r.doc_id!)}>版{r.doc_version}</button> : <span className="inactive">未発行</span>}</td>
              <td className="nowrap">
                {canWrite && !r.voided && <IssueButton type="delivery_note" sourceId={r.id} label="納品書" />}
                {canWrite && !r.voided && !r.invoice_id && <button className="secondary" onClick={() => invoice(r)}>この納品を請求</button>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8}>該当する納品がありません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
