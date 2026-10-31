import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";
import { InvoiceCreate } from "./InvoiceCreate";
import { INVOICE_STATUS, InvoiceDetail } from "./InvoiceDetail";

type Row = {
  id: string; invoice_no: string; customer_name: string; issue_date: string; due_date: string | null;
  total: number; balance: number; status: string; overdue: boolean; mf_invoice_no: string | null;
};

export function Invoices({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<{ kind: "list" } | { kind: "new" } | { kind: "detail"; id: string }>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (view.kind !== "list") return;
    supabase.from("v_invoice_balance")
      .select("id, invoice_no, customer_name, issue_date, due_date, total, balance, status, overdue, mf_invoice_no")
      .order("invoice_no", { ascending: false })
      .then(({ data, error }) => (error ? setError(error.message) : setRows(data as Row[])));
  }, [view]);

  if (view.kind === "new") {
    return <InvoiceCreate onCreated={(id) => setView({ kind: "detail", id })} onCancel={() => setView({ kind: "list" })} />;
  }
  if (view.kind === "detail") return <InvoiceDetail id={view.id} canWrite={canWrite} onBack={() => setView({ kind: "list" })} />;

  const shown = rows.filter((r) => !filter || r.status === filter);
  return (
    <div className="card">
      <div className="row">
        <h3>請求</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">すべて</option>
          {Object.entries(INVOICE_STATUS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        {canWrite && <button onClick={() => setView({ kind: "new" })}>締め請求を作成</button>}
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>請求書番号</th><th>得意先</th><th>請求日</th><th>支払期日</th><th>合計</th><th>残高</th><th>状態</th><th>MF番号</th><th></th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className={r.status === "void" ? "inactive" : ""}>
              <td>{r.invoice_no}</td><td>{r.customer_name}</td><td>{r.issue_date}</td>
              <td className={r.overdue ? "error" : ""}>{r.due_date ?? ""}{r.overdue && "（超過）"}</td>
              <td>{yen(r.total)}</td><td>{r.status === "issued" ? yen(r.balance) : "-"}</td>
              <td>{INVOICE_STATUS[r.status]}</td><td>{r.mf_invoice_no ?? ""}</td>
              <td><button className="secondary" onClick={() => setView({ kind: "detail", id: r.id })}>開く</button></td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={9}>請求書がありません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
