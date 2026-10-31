import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Cat = { code: string; name: string; is_reduced: boolean };
type Period = { id: string; category_code: string; rate: number; valid_from: string; valid_to: string | null };

const pctText = (r: number) => `${Math.round(Number(r) * 10000) / 100}%`;

/** 税区分と税率（期間つき）。税率の変更は管理者のみ。納品日の時点の税率が納品に固定されるため、納品済みの日付へのさかのぼり変更はDBが拒否する。 */
export function TaxRates({ isAdmin }: { isAdmin: boolean }) {
  const [cats, setCats] = useState<Cat[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [category, setCategory] = useState("");
  const [ratePct, setRatePct] = useState("");
  const [from, setFrom] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newReduced, setNewReduced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([
      supabase.from("tax_categories").select("code, name, is_reduced").order("sort_order"),
      supabase.from("tax_rate_periods").select("id, category_code, rate, valid_from, valid_to").order("valid_from", { ascending: false }),
    ]);
    if (c.error || p.error) return setError((c.error ?? p.error)!.message);
    setCats(c.data as Cat[]);
    setPeriods(p.data as Period[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function setRate(e: React.FormEvent) {
    e.preventDefault();
    const rate = Number(ratePct) / 100;
    if (!(rate >= 0 && rate < 1)) return setError("税率は0以上100未満で入力してください");
    const { error } = await supabase.rpc("set_tax_rate", { p_category: category, p_rate: rate, p_valid_from: from });
    setError(error?.message ?? null);
    if (!error) { setRatePct(""); setFrom(""); load(); }
  }

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("tax_categories")
      .insert({ code: newCode.trim(), name: newName.trim(), is_reduced: newReduced, sort_order: cats.length + 1 });
    setError(error?.message ?? null);
    if (!error) { setNewCode(""); setNewName(""); setNewReduced(false); load(); }
  }

  return (
    <div className="stack">
      {cats.map((c) => (
        <div key={c.code} className="card">
          <h3>{c.name}（{c.code}）{c.is_reduced && "　※帳票に軽減税率の印を付けます"}</h3>
          <table>
            <thead><tr><th>税率</th><th>適用開始</th><th>適用終了</th></tr></thead>
            <tbody>
              {periods.filter((p) => p.category_code === c.code).map((p) => (
                <tr key={p.id}><td>{pctText(p.rate)}</td><td>{p.valid_from}</td><td>{p.valid_to ?? "現在も有効"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      {isAdmin ? (
        <>
          <form className="card form" onSubmit={setRate}>
            <h3>税率を登録・変更</h3>
            <p className="inactive">法改正で税率が変わるときに、<strong>施行が確定してから</strong>登録します。直前の期間は前日で自動的に閉じます。</p>
            <div className="grid">
              <label>税区分 *
                <select value={category} onChange={(e) => setCategory(e.target.value)} required>
                  <option value="">選択</option>
                  {cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              </label>
              <label>新しい税率（%） *<input type="number" step="0.01" min="0" max="99.99" value={ratePct} onChange={(e) => setRatePct(e.target.value)} required /></label>
              <label>適用開始日 *<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
            </div>
            <div><button>登録</button></div>
          </form>
          <form className="card form" onSubmit={addCategory}>
            <h3>税区分を追加</h3>
            <div className="grid">
              <label>コード（英数字） *<input value={newCode} onChange={(e) => setNewCode(e.target.value)} pattern="[a-z0-9_]+" required /></label>
              <label>名称 *<input value={newName} onChange={(e) => setNewName(e.target.value)} required /></label>
              <label className="check"><input type="checkbox" checked={newReduced} onChange={(e) => setNewReduced(e.target.checked)} /> 軽減税率の対象（帳票に※を付ける）</label>
            </div>
            <p className="inactive">追加した区分の最初の税率は、上の「税率を登録・変更」から登録してください。</p>
            <div><button>追加</button></div>
          </form>
        </>
      ) : <p className="inactive">税率の変更は管理者のみ可能です。</p>}
    </div>
  );
}
