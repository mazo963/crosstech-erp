import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { MasterDef } from "../lib/masters";
import { MasterForm, type Row, type toPayload } from "./MasterForm";

/** 得意先・外注先に共通の一覧＋登録・編集。削除はせず「取引中」のON/OFFで管理する。 */
export function MasterPage({ def, canWrite }: { def: MasterDef; canWrite: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from(def.table).select("*").order("name");
    if (error) setError(error.message);
    else setRows(data as Row[]);
  }, [def.table]);
  useEffect(() => { setEditing(null); setError(null); load(); }, [load]);

  async function save(payload: ReturnType<typeof toPayload>) {
    setBusy(true);
    setError(null);
    const q = editing === "new"
      ? supabase.from(def.table).insert(payload as never)
      : supabase.from(def.table).update(payload as never).eq("id", (editing as Row).id!);
    const { error } = await q;
    setBusy(false);
    if (error) return setError(error.message);
    setEditing(null);
    load();
  }

  if (editing) {
    return <MasterForm fields={def.fields} initial={editing === "new" ? null : editing} busy={busy}
      error={error} onSave={save} onCancel={() => { setEditing(null); setError(null); }} />;
  }
  const listFields = def.fields.filter((f) => f.list);
  const shown = rows.filter((r) => showInactive || r.active);
  return (
    <div className="card">
      <div className="row">
        <h3>{def.title}マスタ</h3>
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 取引終了も表示</label>
        {canWrite && <button onClick={() => setEditing("new")}>新規登録</button>}
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr>{listFields.map((f) => <th key={f.key}>{f.label}</th>)}<th></th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className={r.active ? "" : "inactive"}>
              {listFields.map((f) => <td key={f.key}>{r[f.key] ?? ""}</td>)}
              <td>{canWrite && <button className="secondary" onClick={() => setEditing(r)}>編集</button>}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={listFields.length + 1}>登録がありません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
