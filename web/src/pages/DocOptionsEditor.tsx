import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { DocType } from "../lib/documents";

type ShowKey = "logo" | "seal" | "fax" | "contact" | "valid_until" | "lead_time" | "delivery_place" | "po_no" | "bank" | "payment_terms";
type Vals = { valid_until: string | null; delivery_place: string | null; contact_person: string | null; bank_account_id: string | null; payment_terms: string | null; customer_po_no: string | null; fax: string | null };
type Resolved = { source: "default" | "document"; values: Vals; show: Record<ShowKey, boolean>; defaults: Vals; has_logo: boolean; has_seal: boolean };
type Bank = { id: string; label: string };
type Row = { key: ShowKey; label: string; value?: keyof Vals; kind?: "text" | "date" | "bank"; only?: DocType[] };

// 帳票の種類ごとに載せられる項目。値のあるものは書き換えられ、すべて表示する／しないを選べる
const ROWS: Row[] = [
  { key: "valid_until", label: "有効期限", value: "valid_until", kind: "date", only: ["quote"] },
  { key: "lead_time", label: "納期（案件の納期欄）", only: ["quote"] },
  { key: "delivery_place", label: "納入場所", value: "delivery_place", only: ["delivery_note", "invoice"] },
  { key: "po_no", label: "客先注文番号（案件の欄から）", only: ["delivery_note", "invoice"] },
  { key: "payment_terms", label: "支払条件", value: "payment_terms", only: ["invoice"] },
  { key: "bank", label: "振込先", value: "bank_account_id", kind: "bank", only: ["invoice"] },
  { key: "contact", label: "自社の担当者名", value: "contact_person" },
  { key: "fax", label: "自社のFAX（設定画面の値）" },
  { key: "logo", label: "自社ロゴ" },
  { key: "seal", label: "社印" },
];
const LABEL: Record<DocType, string> = { quote: "見積書", delivery_note: "納品書", invoice: "請求書" };

/** 帳票の記載項目（有効期限・納期・納入場所・支払条件・振込先・担当者・FAX・ロゴ・社印）。既定は設定・マスタの値で、この帳票だけ変更や非表示にできる。 */
export function DocOptionsEditor({ type, sourceId, canWrite, rev, onSaved }: { type: DocType; sourceId: string; canWrite: boolean; rev: number; onSaved: () => void }) {
  const [r, setR] = useState<Resolved | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([supabase.rpc("resolve_doc_options", { p_type: type, p_source_id: sourceId }), supabase.from("bank_accounts").select("id, label").eq("active", true).order("created_at")]);
    if (a.error) return setError(a.error.message);
    const x = a.data as Resolved;
    setR(x); setBanks((b.data as Bank[]) ?? []);
    setVals(Object.fromEntries(Object.entries(x.values).map(([k, v]) => [k, v == null ? "" : String(v)])));
    setShow({ ...x.show });
  }, [type, sourceId]);
  useEffect(() => { setOpen(false); setError(null); load(); }, [load, rev]);

  if (!r) return error ? <p className="error">{error}</p> : null;
  const rows = ROWS.filter((w) => !w.only || w.only.includes(type));
  const hidden = rows.filter((w) => !r.show[w.key]).map((w) => w.label.replace(/（.*）/, ""));
  const mark = (w: Row) => (w.key === "logo" && !r.has_logo) || (w.key === "seal" && !r.has_seal) ? "（未登録: 設定画面で画像を登録）" : "";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    // 既定と同じ値は保存しない（既定を変えたとき、この帳票も追従する）。表示する項目は null（既定）
    const own = (k: keyof Vals) => (vals[k] === "" || vals[k] === (r!.defaults[k] == null ? "" : String(r!.defaults[k])) ? null : vals[k]);
    const row: Record<string, unknown> = { doc_type: type, source_id: sourceId };
    for (const w of rows) {
      row[`show_${w.key}`] = show[w.key] ? null : false;
      if (w.value && w.value !== "bank_account_id") row[w.value] = own(w.value);
      if (w.value === "bank_account_id") row.bank_account_id = vals.bank_account_id && vals.bank_account_id !== r!.defaults.bank_account_id ? vals.bank_account_id : null;
    }
    const { error } = await supabase.from("doc_options").upsert(row, { onConflict: "doc_type,source_id" });
    setBusy(false);
    if (error) return setError(error.message);
    onSaved();
  }
  async function reset() {
    setBusy(true); setError(null);
    const { error } = await supabase.from("doc_options").delete().eq("doc_type", type).eq("source_id", sourceId);
    setBusy(false);
    if (error) return setError(error.message);
    onSaved();
  }

  return (
    <div className="card stack no-print">
      <div className="row">
        <h3>記載項目（{LABEL[type]}）</h3>
        {canWrite && !open && <button type="button" className="secondary" onClick={() => setOpen(true)}>変更</button>}
      </div>
      <p className="inactive">
        {r.source === "document" ? "この帳票用に変更済み" : "設定・マスタの既定どおり"}
        {hidden.length > 0 && `　／　表示しない: ${hidden.join("、")}`}
      </p>
      {open && canWrite && (
        <form className="stack" onSubmit={save}>
          <div className="opt-grid">
            {rows.map((w) => (
              <FieldRow key={w.key} w={w} checked={!!show[w.key]} onCheck={(v) => setShow({ ...show, [w.key]: v })} note={mark(w)}>
                {w.value && w.kind === "bank" ? (
                  <select value={vals.bank_account_id ?? ""} disabled={!show[w.key]} onChange={(e) => setVals({ ...vals, bank_account_id: e.target.value })}>
                    <option value="">（口座を選ぶ）</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                ) : w.value ? (
                  <input type={w.kind === "date" ? "date" : "text"} value={vals[w.value] ?? ""} disabled={!show[w.key]} onChange={(e) => setVals({ ...vals, [w.value!]: e.target.value })} />
                ) : <span className="inactive">{w.key === "fax" ? (r.values.fax ?? "未登録") : ""}</span>}
              </FieldRow>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div className="row wrap">
            <button disabled={busy}>{busy ? "保存中…" : "保存"}</button>
            {r.source === "document" && <button type="button" className="secondary" disabled={busy} onClick={reset}>この帳票の変更をやめて、既定に戻す</button>}
            <button type="button" className="secondary" onClick={() => { setOpen(false); load(); }}>キャンセル</button>
          </div>
          <p className="inactive">値を空にすると既定に戻ります。非表示にした項目は印刷されません。発行済みの帳票は変わりません（再発行すると新しい版になります）。</p>
        </form>
      )}
      {!open && error && <p className="error">{error}</p>}
    </div>
  );
}

function FieldRow({ w, checked, onCheck, note, children }: { w: Row; checked: boolean; onCheck: (v: boolean) => void; note: string; children: React.ReactNode }) {
  return (
    <>
      <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} />{w.label}を表示{note && <span className="inactive">{note}</span>}</label>
      <div>{children}</div>
    </>
  );
}
