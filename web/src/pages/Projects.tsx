import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { pct, yen } from "../lib/format";
import { clearRoute } from "../lib/nav";
import { JuchuSync } from "./JuchuSync";
import { ProjectEdit } from "./ProjectEdit";

type Row = {
  id: string; project_no: string; title: string; customer_name: string; status: string; progress: string;
  due_date: string | null; sales_amount: number; margin_pct: number | null; delivery_pct: number;
};

const PROGRESS: Record<string, string> = {
  estimate: "見積中", ordered: "受注", partial: "一部納品", delivered: "納品済", invoiced: "請求済", lost: "失注", closed: "完了",
};

export function Projects({ myId, canWrite, routeId }: { myId: string; canWrite: boolean; routeId?: string | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (routeId) setEditing(routeId); }, [routeId]); // 他のタブから案件を開く（#project=…）

  useEffect(() => {
    if (editing) return;
    supabase.from("v_project_summary")
      .select("id, project_no, title, customer_name, status, progress, due_date, sales_amount, margin_pct, delivery_pct")
      .order("project_no", { ascending: false })
      .then(({ data, error }) => (error ? setError(error.message) : setRows(data as Row[])));
  }, [editing]);

  if (editing) {
    return <ProjectEdit id={editing === "new" ? null : editing} myId={myId} canWrite={canWrite} onBack={() => { setEditing(null); clearRoute(); }} />;
  }
  const shown = rows.filter((r) => !filter || r.progress === filter);
  return (
    <div className="stack">
    <JuchuSync canWrite={canWrite} />
    <div className="card">
      <div className="row">
        <h3>案件</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">すべて</option>
          {Object.entries(PROGRESS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        {canWrite && <button onClick={() => setEditing("new")}>新規案件</button>}
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>案件番号</th><th>得意先</th><th>案件名</th><th>進捗</th><th>納期</th><th>売上</th><th>粗利率</th><th></th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td>{r.project_no}</td><td>{r.customer_name}</td><td>{r.title}</td>
              <td>{PROGRESS[r.progress] ?? r.progress}{r.progress === "partial" ? `（${r.delivery_pct}%）` : ""}</td>
              <td>{r.due_date ?? ""}</td><td>{yen(r.sales_amount)}</td><td>{pct(r.margin_pct)}</td>
              <td><button className="secondary" onClick={() => setEditing(r.id)}>開く</button></td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={8}>案件がありません</td></tr>}
        </tbody>
      </table>
    </div>
    </div>
  );
}
