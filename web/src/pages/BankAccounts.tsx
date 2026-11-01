import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Bank = { id: string; label: string; bank_name: string; branch_name: string | null; account_type: string; account_number: string; account_holder: string; is_default: boolean; active: boolean };
const EMPTY = { label: "", bank_name: "", branch_name: "", account_type: "普通", account_number: "", account_holder: "" };

/** 振込先の口座（複数）。請求書ごとに、どの口座を載せるか選べる。削除はせず、使わないものは無効にする。 */
export function BankAccounts({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<Bank[]>([]);
  const [n, setN] = useState(EMPTY);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => supabase.from("bank_accounts").select("*").order("created_at").then((r) => setRows((r.data as Bank[]) ?? [])), []);
  useEffect(() => { load(); }, [load]);

  const fail = (e: { message: string } | null, ok: string) => { setMsg(e ? `保存できません: ${e.message}` : ok); load(); };
  const nul = (s: string | null) => (s == null || s.trim() === "" ? null : s.trim());
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("bank_accounts").insert({ ...n, branch_name: nul(n.branch_name), is_default: rows.filter((r) => r.active).length === 0 });
    if (!error) setN(EMPTY);
    fail(error, "口座を登録しました");
  }
  async function save(b: Bank) {
    const { error } = await supabase.from("bank_accounts").update({ label: b.label, bank_name: b.bank_name, branch_name: nul(b.branch_name), account_type: b.account_type, account_number: b.account_number, account_holder: b.account_holder, active: b.active }).eq("id", b.id);
    fail(error, `${b.label} を保存しました`);
  }
  async function makeDefault(b: Bank) {
    const off = await supabase.from("bank_accounts").update({ is_default: false }).eq("is_default", true);
    if (off.error) return fail(off.error, "");
    const { error } = await supabase.from("bank_accounts").update({ is_default: true }).eq("id", b.id);
    fail(error, `${b.label} を、請求書の既定の振込先にしました`);
  }
  const edit = (id: string, patch: Partial<Bank>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const cell = (b: Bank, k: "label" | "bank_name" | "branch_name" | "account_number" | "account_holder") =>
    <td><input value={b[k] ?? ""} disabled={!isAdmin} onChange={(e) => edit(b.id, { [k]: e.target.value })} /></td>;

  return (
    <div className="card stack">
      <h3>振込先の口座</h3>
      <div className="tablewrap"><table>
        <thead><tr><th>呼び名</th><th>銀行名</th><th>支店名</th><th>種別</th><th>口座番号</th><th>名義</th><th>既定</th><th>有効</th><th></th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              {cell(b, "label")}{cell(b, "bank_name")}{cell(b, "branch_name")}
              <td><select value={b.account_type} disabled={!isAdmin} onChange={(e) => edit(b.id, { account_type: e.target.value })}>{["普通", "当座", "貯蓄"].map((t) => <option key={t}>{t}</option>)}</select></td>
              {cell(b, "account_number")}{cell(b, "account_holder")}
              <td>{b.is_default ? "既定" : isAdmin && b.active && <button type="button" className="secondary" onClick={() => makeDefault(b)}>既定にする</button>}</td>
              <td><input type="checkbox" checked={b.active} disabled={!isAdmin || b.is_default} onChange={(e) => edit(b.id, { active: e.target.checked })} /></td>
              <td>{isAdmin && <button type="button" className="secondary" onClick={() => save(b)}>保存</button>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={9} className="inactive">口座が未登録です（未登録のときは、自社情報の「振込先（自由記入）」を使います）</td></tr>}
        </tbody>
      </table></div>
      {isAdmin && (
        <form className="row wrap" onSubmit={add}>
          <input placeholder="呼び名（例: A銀行 普通）" value={n.label} onChange={(e) => setN({ ...n, label: e.target.value })} required />
          <input placeholder="銀行名" value={n.bank_name} onChange={(e) => setN({ ...n, bank_name: e.target.value })} required />
          <input placeholder="支店名" value={n.branch_name} onChange={(e) => setN({ ...n, branch_name: e.target.value })} />
          <select value={n.account_type} onChange={(e) => setN({ ...n, account_type: e.target.value })}>{["普通", "当座", "貯蓄"].map((t) => <option key={t}>{t}</option>)}</select>
          <input placeholder="口座番号" value={n.account_number} onChange={(e) => setN({ ...n, account_number: e.target.value })} required />
          <input placeholder="名義（カナ）" value={n.account_holder} onChange={(e) => setN({ ...n, account_holder: e.target.value })} required />
          <button>口座を追加</button>
        </form>
      )}
      {msg && <p className={msg.includes("できません") ? "error" : ""}>{msg}</p>}
      <p className="inactive">請求書には「既定」の口座が載ります。請求書の画面で、請求書ごとに別の口座を選んだり、載せない設定にもできます。発行済みの請求書は、あとで口座を変えても変わりません。</p>
    </div>
  );
}
