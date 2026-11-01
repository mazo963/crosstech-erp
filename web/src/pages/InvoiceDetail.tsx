import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";
import { IssueButton } from "./IssueButton";
import { AddresseeEditor } from "./AddresseeEditor";
import { DocOptionsEditor } from "./DocOptionsEditor";
import { DocPreview } from "./DocPreview";

type Inv = {
  id: string; invoice_no: string; customer_name: string; period_from: string | null; period_to: string; issue_date: string;
  due_date: string | null; subtotal: number; tax_rate: number; tax: number; total: number; status: string;
  mf_invoice_no: string | null; notes: string | null; allocated: number; balance: number;
};
type Line = { id: string; description: string; quantity: number; unit_price: number; amount: number; is_reduced: boolean; tax_rate: number };
type Sum = { tax_rate: number; is_reduced: boolean; taxable_amount: number; tax_amount: number };

export const INVOICE_STATUS: Record<string, string> = { draft: "下書き", issued: "発行済", void: "取消" };

/** 請求書の内容と、発行・取消。金額は DB が確定した値をそのまま表示する。 */
export function InvoiceDetail({ id, canWrite, onBack }: { id: string; canWrite: boolean; onBack: () => void }) {
  const [inv, setInv] = useState<Inv | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [sums, setSums] = useState<Sum[]>([]);
  const [addrRev, setAddrRev] = useState(0);
  const [mfNo, setMfNo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase.from("v_invoice_balance").select("*").eq("id", id).single(),
      supabase.from("invoice_lines").select("id, description, quantity, unit_price, amount, is_reduced, tax_rate").eq("invoice_id", id).order("description"),
      supabase.from("invoice_tax_summary").select("tax_rate, is_reduced, taxable_amount, tax_amount").eq("invoice_id", id).order("tax_rate", { ascending: false }),
    ]);
    if (a.error || b.error || c.error) return setError((a.error ?? b.error ?? c.error)!.message);
    setInv(a.data as Inv);
    setMfNo((a.data as Inv).mf_invoice_no ?? "");
    setLines(b.data as Line[]);
    setSums(c.data as Sum[]);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await p;
    setError(error?.message ?? null);
    if (!error) await load();
  }
  const issue = () => run(supabase.rpc("issue_invoice", { p_invoice_id: id, p_mf_invoice_no: mfNo.trim() || null }));
  const voidIt = () => {
    const reason = window.prompt("この請求書を取り消します。取消理由を入力してください");
    if (reason?.trim()) run(supabase.rpc("void_invoice", { p_invoice_id: id, p_reason: reason.trim() }));
  };

  if (!inv) return <p className={error ? "error" : ""}>{error ?? "読み込み中…"}</p>;
  return (
    <div className="split">
    <div className="split-main stack">
      <div className="row">
        <button className="secondary" onClick={onBack}>← 一覧へ</button>
        <h2>{inv.invoice_no}（{INVOICE_STATUS[inv.status]}）</h2>
      </div>
      <div className="card">
        <p><strong>{inv.customer_name}</strong>　請求日 {inv.issue_date}　対象期間 {inv.period_from ?? "初回"} 〜 {inv.period_to}　支払期日 {inv.due_date ?? "-"}</p>
        {inv.notes && <p className="inactive">{inv.notes}</p>}
        <table>
          <thead><tr><th>内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
          <tbody>
            {lines.map((l) => <tr key={l.id}><td className="wrap">{l.is_reduced && "※ "}{l.description}</td><td>{l.quantity}</td><td>{yen(l.unit_price)}</td><td>{yen(l.amount)}</td></tr>)}
          </tbody>
        </table>
        <p>小計（税抜） {yen(inv.subtotal)}</p>
        {sums.map((s) => <p key={s.tax_rate}>{Math.round(Number(s.tax_rate) * 10000) / 100}%対象{s.is_reduced && "（※軽減税率）"} {yen(s.taxable_amount)}　消費税 {yen(s.tax_amount)}</p>)}
        <p><strong>合計 {yen(inv.total)}</strong></p>
        {inv.status === "issued" && <p>入金消込済 {yen(inv.allocated)}　残高 <strong>{yen(inv.balance)}</strong></p>}
      </div>
      {error && <p className="error">{error}</p>}
      {canWrite && inv.status === "issued" && <div className="card row"><IssueButton type="invoice" sourceId={id} label="請求書（控え）を発行・表示" /></div>}
      {canWrite && inv.status !== "void" && (
        <div className="card row">
          {inv.status === "draft" && (
            <>
              <label>MFの請求書番号（MFで発行済みなら入力）
                <input value={mfNo} onChange={(e) => setMfNo(e.target.value)} />
              </label>
              <button onClick={issue}>発行済みにする</button>
            </>
          )}
          <button className="secondary" onClick={voidIt}>取消</button>
        </div>
      )}
    </div>
    <aside className="split-side">
      <div className="card stack">
        <p className="inactive">請求書の発行イメージ{inv.status === "draft" ? "（下書き。発行済みにしてから、帳票として発行・固定します）" : "（現在の内容。固定した帳票は「帳票」タブ）"}</p>
        <AddresseeEditor type="invoice" sourceId={id} canWrite={canWrite} rev={addrRev} onSaved={() => setAddrRev((n) => n + 1)} />
        <DocOptionsEditor type="invoice" sourceId={id} canWrite={canWrite} rev={addrRev} onSaved={() => setAddrRev((n) => n + 1)} />
        <DocPreview type="invoice" sourceId={id} rev={inv.total + inv.status.length + addrRev} />
      </div>
    </aside>
    </div>
  );
}
