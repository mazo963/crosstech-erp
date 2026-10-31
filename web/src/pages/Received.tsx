import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { yen } from "../lib/format";
import { TS_STATUS } from "../lib/timestamp";
import { CATEGORY, ReceivedForm } from "./ReceivedForm";
import { TimestampStatus } from "./TimestampStatus";

type Row = {
  id: string; kind: string; doc_category: string; doc_date: string; amount: number; counterparty_name: string; received_on: string;
  file_name: string; input_timeliness: string; deadline_max: string; resolution_dpi: number | null; voided: boolean; void_reason: string | null;
};
const TIMELINESS: Record<string, string> = { early: "7営業日以内", cycle: "2か月+7営業日以内", late: "期限超過" };

/** 受領した書類（電子取引・スキャナ保存）。取引年月日・取引金額・取引先で検索できる。登録後は変更・削除できない。 */
export function Received({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [ts, setTs] = useState<Record<string, string>>({});
  const [f, setF] = useState({ kind: "", cat: "", from: "", to: "", min: "", max: "", name: "", voided: false });
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));

  const load = useCallback(async () => {
    let q = supabase.from("received_documents")
      .select("id, kind, doc_category, doc_date, amount, counterparty_name, received_on, file_name, input_timeliness, deadline_max, resolution_dpi, voided, void_reason")
      .order("doc_date", { ascending: false }).limit(200);
    if (f.kind) q = q.eq("kind", f.kind);
    if (f.cat) q = q.eq("doc_category", f.cat);
    if (f.from) q = q.gte("doc_date", f.from);
    if (f.to) q = q.lte("doc_date", f.to);
    if (f.min) q = q.gte("amount", Number(f.min));
    if (f.max) q = q.lte("amount", Number(f.max));
    if (f.name.trim()) q = q.ilike("counterparty_name", `%${f.name.trim()}%`);
    if (!f.voided) q = q.eq("voided", false);
    const [r, s] = await Promise.all([q, supabase.from("v_timestamp_status").select("subject_id, status").eq("subject_table", "received_documents")]);
    if (r.error) return setMsg(r.error.message);
    setRows(r.data as Row[]);
    setTs(Object.fromEntries(((s.data as { subject_id: string; status: string }[]) ?? []).map((x) => [x.subject_id, x.status])));
  }, [f]);
  useEffect(() => { load(); }, [load, tick]);

  async function download(r: Row) {
    const { data, error } = await supabase.rpc("received_file_base64", { p_id: r.id });
    if (error || typeof data !== "string") return setMsg(error?.message ?? "取得できません");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]));
    a.download = r.file_name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function voidIt(r: Row) {
    const reason = window.prompt(`${r.counterparty_name} ${r.file_name} を取り消します。取消理由を入力してください（登録し直す場合に使います）`);
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc("void_received_document", { p_id: r.id, p_reason: reason.trim() });
    setMsg(error?.message ?? null);
    if (!error) setTick((t) => t + 1);
  }

  if (adding) return <ReceivedForm onCancel={() => setAdding(false)} onDone={(m) => { setAdding(false); setMsg(m); setTick((t) => t + 1); }} />;
  return (
    <div className="stack">
      <TimestampStatus canWrite={canWrite} refreshKey={tick} />
      <div className="card stack">
        <div className="row"><h3>受領書類（電子取引・スキャナ保存）</h3>{canWrite && <button onClick={() => setAdding(true)}>受領書類を登録</button>}</div>
        <div className="grid">
          <label>保存の種類<select value={f.kind} onChange={(e) => set("kind", e.target.value)}><option value="">すべて</option><option value="electronic">電子取引</option><option value="scanned">スキャナ保存</option></select></label>
          <label>書類の種類<select value={f.cat} onChange={(e) => set("cat", e.target.value)}><option value="">すべて</option>{CATEGORY.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
          <label>取引年月日（から）<input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></label>
          <label>取引年月日（まで）<input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></label>
          <label>取引金額（以上）<input type="number" value={f.min} onChange={(e) => set("min", e.target.value)} /></label>
          <label>取引金額（以下）<input type="number" value={f.max} onChange={(e) => set("max", e.target.value)} /></label>
          <label>取引先（一部でも可）<input value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={f.voided} onChange={(e) => set("voided", e.target.checked)} /> 取消済みも表示</label>
        </div>
        {msg && <p className="inactive">{msg}</p>}
        <table>
          <thead><tr><th>取引年月日</th><th>取引先</th><th>種類</th><th>金額</th><th>保存</th><th>授受日</th><th>入力期限</th><th>タイムスタンプ</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.voided ? "inactive" : ""}>
                <td>{r.doc_date}</td><td>{r.counterparty_name}{r.voided && `（取消: ${r.void_reason}）`}</td>
                <td>{CATEGORY.find(([v]) => v === r.doc_category)?.[1]}</td><td>{yen(r.amount)}</td>
                <td>{r.kind === "scanned" ? `スキャン ${r.resolution_dpi}dpi` : "電子取引"}</td><td>{r.received_on}</td>
                <td className={r.input_timeliness === "late" ? "error" : ""}>{TIMELINESS[r.input_timeliness]}</td>
                <td className={ts[r.id] === "overdue" ? "error" : ""}>{TS_STATUS[ts[r.id]] ?? "-"}</td>
                <td><button className="secondary" onClick={() => download(r)}>表示</button>{canWrite && !r.voided && <button className="secondary" onClick={() => voidIt(r)}>取消</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9}>該当する書類がありません（最大200件）</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
