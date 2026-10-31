import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { pct, yen } from "../lib/format";
import { go } from "../lib/nav";
import { openDocument } from "../lib/documents";
import { IssueButton } from "./IssueButton";

type Row = { id: string; project_no: string; title: string; customer_name: string; status: string; progress: string; estimate_date: string | null; due_date: string | null; sales_amount: number; margin_pct: number | null };
type QDoc = { id: string; source_id: string; version: number; amount: number };

const PROGRESS: Record<string, string> = { estimate: "見積中", ordered: "受注", partial: "一部納品", delivered: "納品済", invoiced: "請求済", lost: "失注", closed: "完了" };

/** 見積の一覧。見積書の発行状況と、受注・納品・請求への入口。変換ボタンは各案件の画面にある。 */
export function Quotes({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [docs, setDocs] = useState<Record<string, QDoc>>({});
  const [filter, setFilter] = useState("estimate");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let q = supabase.from("v_project_summary")
      .select("id, project_no, title, customer_name, status, progress, estimate_date, due_date, sales_amount, margin_pct")
      .order("project_no", { ascending: false }).limit(300);
    if (filter === "estimate") q = q.eq("status", "estimate");
    else if (filter === "lost") q = q.eq("status", "lost");
    else if (filter === "ordered") q = q.in("status", ["ordered", "closed"]);
    if (name.trim()) q = q.ilike("customer_name", `%${name.trim()}%`);
    Promise.all([q, supabase.from("issued_documents").select("id, source_id, version, amount").eq("doc_type", "quote").order("version")]).then(([r, d]) => {
      if (r.error) return setError(r.error.message);
      setRows(r.data as Row[]);
      setDocs(Object.fromEntries(((d.data as QDoc[]) ?? []).map((x) => [x.source_id, x]))); // 版が新しいものが後に来て上書きする
    });
  }, [filter, name]);

  return (
    <div className="card stack">
      <div className="row">
        <h3>見積</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="estimate">見積中</option><option value="ordered">受注済み（受注・完了）</option><option value="lost">失注</option><option value="">すべて</option>
        </select>
        <input placeholder="得意先で絞り込み" value={name} onChange={(e) => setName(e.target.value)} />
        {canWrite && <button onClick={() => go("project", "new")}>新規見積</button>}
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>見積番号</th><th>見積日</th><th>得意先</th><th>案件名</th><th>見積金額（税抜）</th><th>粗利率</th><th>状態</th><th>見積書</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const d = docs[r.id];
            return (
              <tr key={r.id}>
                <td className="nowrap">{r.project_no}</td><td className="nowrap">{r.estimate_date ?? ""}</td><td>{r.customer_name}</td><td>{r.title}</td>
                <td className="nowrap">{yen(r.sales_amount)}</td><td>{pct(r.margin_pct)}</td><td className="nowrap">{PROGRESS[r.progress] ?? r.progress}</td>
                <td className="nowrap">{d ? <button className="linkbtn" onClick={() => openDocument(d.id)}>版{d.version}（税込{yen(d.amount)}）</button> : <span className="inactive">未発行</span>}</td>
                <td className="nowrap">
                  <button className="secondary" onClick={() => go("project", r.id)}>開く・変換</button>
                  {canWrite && <IssueButton type="quote" sourceId={r.id} label="見積書" />}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={9}>該当する見積がありません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
