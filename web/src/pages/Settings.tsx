import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { type Settings as S, useSettings } from "../lib/useSettings";

type Staff = { id: string; name: string; role: string; worker_code: string; active: boolean };
const ROUNDING: [string, string][] = [["floor", "切捨て"], ["round", "四捨五入"], ["ceil", "切上げ"]];
const ROLES: [string, string][] = [["admin", "管理者"], ["office", "事務"], ["viewer", "閲覧のみ"]];

/** 自社情報・送付の設定・スタッフ。変更できるのは管理者だけ（DBも同じ）。 */
export function Settings({ isAdmin }: { isAdmin: boolean }) {
  const { settings, reload } = useSettings();
  const [f, setF] = useState<S | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (settings) setF(settings); }, [settings]);
  const loadStaff = () => supabase.from("staff").select("id, name, role, worker_code, active").order("name").then((r) => setStaff((r.data as Staff[]) ?? []));
  useEffect(() => { loadStaff(); }, []);

  if (!f) return <p>読み込み中…</p>;
  const set = <K extends keyof S>(k: K, v: S[K]) => setF({ ...f, [k]: v });
  const text = (k: keyof S, label: string, o: { area?: boolean; hint?: string; pattern?: string } = {}) => (
    <label className={o.area ? "wide" : ""}>{label}
      {o.area
        ? <textarea rows={3} value={(f[k] as string | null) ?? ""} onChange={(e) => set(k, e.target.value as never)} disabled={!isAdmin} />
        : <input value={(f[k] as string | null) ?? ""} onChange={(e) => set(k, e.target.value as never)} disabled={!isAdmin} pattern={o.pattern} title={o.hint} placeholder={o.hint} />}
    </label>
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const nul = (v: string | null) => (v == null || v.trim() === "" ? null : v.trim());
    const { error } = await supabase.from("company_settings").update({
      company_name: f!.company_name.trim(), invoice_reg_no: nul(f!.invoice_reg_no), postal_code: nul(f!.postal_code), address: nul(f!.address), tel: nul(f!.tel), email: nul(f!.email),
      bank_info: nul(f!.bank_info), tax_rounding: f!.tax_rounding, erp_invoice_official: f!.erp_invoice_official, box_import_email: nul(f!.box_import_email),
      mail_signature: nul(f!.mail_signature), own_timestamp: f!.own_timestamp,
    }).eq("id", 1);
    setBusy(false);
    setMsg(error ? `保存できません: ${error.message}` : "保存しました。これから発行する帳票に反映されます（発行済みの帳票は変わりません）");
    if (!error) reload();
  }
  async function saveStaff(s: Staff) {
    const { error } = await supabase.from("staff").update({ name: s.name.trim(), role: s.role, active: s.active }).eq("id", s.id);
    setMsg(error ? `スタッフを保存できません: ${error.message}` : `${s.name} を保存しました`);
    loadStaff();
  }

  return (
    <div className="stack">
      {!isAdmin && <p className="inactive">設定を変更できるのは管理者だけです（表示のみ）。</p>}
      <form className="card form" onSubmit={save}>
        <h3>自社情報（帳票に印字されます）</h3>
        <div className="grid">
          {text("company_name", "会社名 *")}
          {text("invoice_reg_no", "適格請求書発行事業者の登録番号", { hint: "T + 数字13桁", pattern: "T[0-9]{13}" })}
          {text("postal_code", "郵便番号")}
          {text("address", "住所")}
          {text("tel", "電話")}
          {text("email", "メール")}
          {text("bank_info", "振込先（請求書に印字）", { area: true })}
          <label>消費税の端数処理（請求書1枚・税率ごとに1回）
            <select value={f.tax_rounding} onChange={(e) => set("tax_rounding", e.target.value)} disabled={!isAdmin}>{ROUNDING.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
          </label>
        </div>
        <h3>請求書</h3>
        <label className="check"><input type="checkbox" checked={f.erp_invoice_official} onChange={(e) => set("erp_invoice_official", e.target.checked)} disabled={!isAdmin} />
          このシステムの請求書を、正式な請求書（適格請求書）として発行する（オフにすると「ERP控え・社内用」と表示されます）</label>
        <h3>メール・Box</h3>
        <div className="grid">
          {text("box_import_email", "Box（メール取込）のアドレス", { hint: "Box の「メール取込」用アドレス" })}
          {text("mail_signature", "メール本文の署名（空なら会社名）", { area: true })}
        </div>
        <p className="inactive">Box は、宛先に複数のアドレスが含まれるメールを保存できません。お客様宛とは別のメールで、同じPDFをこのアドレスだけに送ります。</p>
        <h3>タイムスタンプ</h3>
        <label className="check"><input type="checkbox" checked={f.own_timestamp} onChange={(e) => set("own_timestamp", e.target.checked)} disabled={!isAdmin} />
          このシステムで、タイムスタンプを付与する（時刻認証局の設定が必要）。オフのときは、Box など外部のサービスに任せ、期限超過の警告は出しません</label>
        {msg && <p className={msg.includes("できません") ? "error" : ""}>{msg}</p>}
        {isAdmin && <div><button disabled={busy}>{busy ? "保存中…" : "保存"}</button></div>}
      </form>
      <div className="card stack">
        <h3>スタッフ</h3>
        <div className="tablewrap"><table>
          <thead><tr><th>名前</th><th>権限</th><th>操作者コード</th><th>有効</th><th></th></tr></thead>
          <tbody>
            {staff.map((s, i) => (
              <tr key={s.id}>
                <td><input value={s.name} disabled={!isAdmin} onChange={(e) => setStaff(staff.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} /></td>
                <td><select value={s.role} disabled={!isAdmin} onChange={(e) => setStaff(staff.map((x, n) => (n === i ? { ...x, role: e.target.value } : x)))}>{ROLES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></td>
                <td>{s.worker_code}</td>
                <td><input type="checkbox" checked={s.active} disabled={!isAdmin} onChange={(e) => setStaff(staff.map((x, n) => (n === i ? { ...x, active: e.target.checked } : x)))} /></td>
                <td>{isAdmin && <button className="secondary" type="button" onClick={() => saveStaff(s)}>保存</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="inactive">新しいスタッフの追加: Supabase の管理画面（Authentication）でユーザーを作り、SQL で `staff` に登録します（README のセットアップ手順）。</p>
      </div>
    </div>
  );
}
