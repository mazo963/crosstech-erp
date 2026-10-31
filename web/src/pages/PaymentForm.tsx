import { useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";

export type Bal = { customer_id: string; customer_name: string; ar_balance: number; unallocated_payment: number; unbilled_amount: number };

export const METHODS: [string, string][] = [["bank", "銀行振込"], ["cash", "現金"], ["offset", "相殺"], ["other", "その他"]];

/** 入金の登録。消込（古い請求書から順）は record_payment が行う。画面は金額を計算しない。 */
export function PaymentForm({ balances, onDone }: { balances: Bal[]; onDone: () => void }) {
  const [customerId, setCustomerId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("0");
  const [method, setMethod] = useState("bank");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bal = balances.find((b) => b.customer_id === customerId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc("record_payment", {
      p_customer_id: customerId, p_received_on: date, p_amount: Number(amount), p_fee: Number(fee || 0),
      p_method: method, p_memo: memo.trim() || null,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setAmount(""); setFee("0"); setMemo("");
    onDone();
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h3>入金を登録</h3>
      <div className="grid">
        <label>得意先 *
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
            <option value="">選択してください</option>
            {balances.map((b) => <option key={b.customer_id} value={b.customer_id}>{b.customer_name}</option>)}
          </select>
        </label>
        <label>入金日 *<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        <label>入金額（円） *<input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
        <label>先方が差し引いた振込手数料（円）
          <input type="number" min="0" step="1" value={fee} onChange={(e) => setFee(e.target.value)} />
        </label>
        <label>方法
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </label>
        <label>メモ<input value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      </div>
      {bal && <p>この得意先の売掛残高 <strong>{yen(bal.ar_balance)}</strong>　未消込の入金 {yen(bal.unallocated_payment)}</p>}
      <p className="inactive">消込額は「入金額 + 手数料」です。支払期日の古い発行済み請求書から順に自動で消し込みます。残った分は前受として残ります。</p>
      {error && <p className="error">{error}</p>}
      <div><button disabled={busy}>{busy ? "登録中…" : "登録"}</button></div>
    </form>
  );
}
