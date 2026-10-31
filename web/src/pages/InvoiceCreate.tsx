import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";

type Cust = { id: string; name: string; closing_day: number };

/** 締め請求の作成（下書き）。対象行の抽出・合計・消費税・支払期日の計算はすべて create_invoice が行う。 */
export function InvoiceCreate({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [customers, setCustomers] = useState<Cust[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [unbilled, setUnbilled] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("customers").select("id, name, closing_day").eq("active", true).order("name")
      .then((r) => setCustomers((r.data as Cust[]) ?? []));
  }, []);

  async function pick(id: string) {
    setCustomerId(id);
    setUnbilled(null);
    setPeriodTo("");
    const c = customers.find((x) => x.id === id);
    if (!c) return;
    const [end, bal] = await Promise.all([
      supabase.rpc("calc_period_end", { p_base: issueDate, p_closing_day: c.closing_day }),
      supabase.from("v_customer_balance").select("unbilled_amount").eq("customer_id", id).single(),
    ]);
    if (typeof end.data === "string") setPeriodTo(end.data); // 提案値。変更できる
    if (bal.data) setUnbilled(Number(bal.data.unbilled_amount));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc("create_invoice", {
      p_customer_id: customerId, p_period_to: periodTo, p_issue_date: issueDate,
    });
    setBusy(false);
    if (error) return setError(error.message);
    onCreated(data as string);
  }

  return (
    <form className="card form" onSubmit={create}>
      <h3>締め請求を作成（下書き）</h3>
      <label>得意先 *
        <select value={customerId} onChange={(e) => pick(e.target.value)} required>
          <option value="">選択してください</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label>請求日<input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required /></label>
      <label>締め日（この日までの納品を請求） *
        <input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} required />
      </label>
      {unbilled != null && <p>この得意先の未請求の納品（全期間）: <strong>{yen(unbilled)}</strong>（実際の対象は締め日までで、請求の基準の設定にも従います）</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button disabled={busy || !periodTo}>{busy ? "作成中…" : "作成"}</button>
        <button type="button" className="secondary" onClick={onCancel}>キャンセル</button>
      </div>
    </form>
  );
}
