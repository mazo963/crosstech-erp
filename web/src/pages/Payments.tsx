import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";
import { type Bal, METHODS, PaymentForm } from "./PaymentForm";

type Pay = {
  id: string; received_on: string; amount: number; fee: number; method: string; memo: string | null;
  customers: { name: string };
  payment_allocations: { amount: number; invoices: { invoice_no: string } }[];
};

export function Payments({ canWrite }: { canWrite: boolean }) {
  const [balances, setBalances] = useState<Bal[]>([]);
  const [pays, setPays] = useState<Pay[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([
      supabase.from("v_customer_balance").select("*").order("customer_name"),
      supabase.from("payments")
        .select("id, received_on, amount, fee, method, memo, customers(name), payment_allocations(amount, invoices(invoice_no))")
        .order("received_on", { ascending: false }).order("created_at", { ascending: false }).limit(100),
    ]);
    if (b.error || p.error) return setError((b.error ?? p.error)!.message);
    setBalances(b.data as Bal[]);
    setPays(p.data as unknown as Pay[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const withBalance = balances.filter((b) => Number(b.ar_balance) !== 0 || Number(b.unallocated_payment) !== 0 || Number(b.unbilled_amount) !== 0);
  return (
    <div className="stack">
      {canWrite && <PaymentForm balances={balances} onDone={load} />}
      {error && <p className="error">{error}</p>}
      <div className="card">
        <h3>得意先ごとの残高</h3>
        <table>
          <thead><tr><th>得意先</th><th>売掛残高</th><th>未消込の入金（前受）</th><th>未請求</th></tr></thead>
          <tbody>
            {withBalance.map((b) => (
              <tr key={b.customer_id}><td>{b.customer_name}</td><td>{yen(b.ar_balance)}</td><td>{yen(b.unallocated_payment)}</td><td>{yen(b.unbilled_amount)}</td></tr>
            ))}
            {withBalance.length === 0 && <tr><td colSpan={4}>残高のある得意先はありません</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>入金履歴（新しい順・100件）</h3>
        <table>
          <thead><tr><th>入金日</th><th>得意先</th><th>入金額</th><th>手数料</th><th>方法</th><th>消込先</th><th>メモ</th></tr></thead>
          <tbody>
            {pays.map((p) => (
              <tr key={p.id}>
                <td>{p.received_on}</td><td>{p.customers.name}</td><td>{yen(p.amount)}</td><td>{yen(p.fee)}</td>
                <td>{METHODS.find(([v]) => v === p.method)?.[1]}</td>
                <td>{p.payment_allocations.map((a) => `${a.invoices.invoice_no} ${yen(a.amount)}`).join(" / ") || "（未消込）"}</td>
                <td>{p.memo ?? ""}</td>
              </tr>
            ))}
            {pays.length === 0 && <tr><td colSpan={7}>入金の記録はありません</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
