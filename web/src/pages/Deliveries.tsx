import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";
import { IssueButton } from "./IssueButton";

type Prog = { id: string; product_no: string; name: string; quantity: number; unit: string; delivered_qty: number; remaining_qty: number };
type Delivery = {
  id: string; delivery_no: string; delivered_on: string; notes: string | null; voided: boolean; void_reason: string | null;
  delivery_lines: { quantity: number; amount: number; project_items: { product_no: string; name: string } }[];
};

/** 分納の記録と履歴。数量チェック・金額・採番は DB（record_delivery / void_delivery）が行う。 */
export function Deliveries({ projectId, status, canWrite, onChanged }: {
  projectId: string; status: string; canWrite: boolean; onChanged: () => void;
}) {
  const [items, setItems] = useState<Prog[]>([]);
  const [history, setHistory] = useState<Delivery[]>([]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, d] = await Promise.all([
      supabase.from("v_item_progress").select("id, product_no, name, quantity, unit, delivered_qty, remaining_qty")
        .eq("project_id", projectId).order("line_no"),
      supabase.from("deliveries")
        .select("id, delivery_no, delivered_on, notes, voided, void_reason, delivery_lines(quantity, amount, project_items(product_no, name))")
        .eq("project_id", projectId).order("delivered_on", { ascending: false }).order("delivery_no", { ascending: false }),
    ]);
    if (p.error || d.error) return setError((p.error ?? d.error)!.message);
    setItems(p.data as Prog[]);
    setHistory(d.data as unknown as Delivery[]);
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  async function record(e: React.FormEvent) {
    e.preventDefault();
    const lines = items.filter((i) => Number(qty[i.id]) > 0).map((i) => ({ item_id: i.id, quantity: Number(qty[i.id]) }));
    if (lines.length === 0) return setError("納品数量を入力してください");
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc("record_delivery", {
      p_project_id: projectId, p_delivered_on: date, p_lines: lines, p_notes: notes.trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setQty({});
    setNotes("");
    await load();
    onChanged();
  }

  async function voidDelivery(d: Delivery) {
    const reason = window.prompt(`${d.delivery_no} を取り消します。取消理由を入力してください`);
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc("void_delivery", { p_delivery_id: d.id, p_reason: reason.trim() });
    if (error) return setError(error.message);
    setError(null);
    await load();
    onChanged();
  }

  return (
    <div className="card stack">
      <h3>分納</h3>
      {canWrite && (
        <form onSubmit={record} className="stack">
          {status === "estimate" && <p className="notice card">見積中の案件に納品を記録すると、状態が「受注」になります。</p>}
          <table>
            <thead><tr><th>製番</th><th>品名</th><th>受注数</th><th>納品済</th><th>残</th><th>今回の納品数</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.product_no}</td><td>{i.name}</td><td>{i.quantity}{i.unit}</td><td>{i.delivered_qty}</td><td>{i.remaining_qty}</td>
                  <td><input type="number" min="0" step="0.01" max={i.remaining_qty} value={qty[i.id] ?? ""} disabled={Number(i.remaining_qty) <= 0}
                    onChange={(e) => setQty((p) => ({ ...p, [i.id]: e.target.value }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <label>納品日<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
            <label>メモ<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            <button disabled={busy}>{busy ? "記録中…" : "納品を記録"}</button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>納品書番号</th><th>納品日</th><th>内容</th><th>金額</th><th></th></tr></thead>
        <tbody>
          {history.map((d) => (
            <tr key={d.id} className={d.voided ? "inactive" : ""}>
              <td>{d.delivery_no}{d.voided && "（取消）"}</td><td>{d.delivered_on}</td>
              <td>{d.delivery_lines.map((l) => `${l.project_items.product_no} ${l.project_items.name} ×${l.quantity}`).join(" / ")}
                {d.voided && d.void_reason ? ` 理由: ${d.void_reason}` : ""}</td>
              <td>{yen(d.delivery_lines.reduce((s, l) => s + Number(l.amount), 0))}</td>
              <td>{canWrite && !d.voided && <><IssueButton type="delivery_note" sourceId={d.id} label="納品書" /><button type="button" className="secondary" onClick={() => voidDelivery(d)}>取消</button></>}</td>
            </tr>
          ))}
          {history.length === 0 && <tr><td colSpan={5}>納品の記録はありません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
