import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { type SubjectTable, TS_STATUS, requestTimestamp } from "../lib/timestamp";

type Row = { subject_table: SubjectTable; subject_id: string; label: string; deadline: string; status: string; first_gen_time: string | null };

/** タイムスタンプが未付与・期限後の書類の一覧と、付与の再実行。 */
export function TimestampStatus({ canWrite, refreshKey }: { canWrite: boolean; refreshKey: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("v_timestamp_status")
      .select("subject_table, subject_id, label, deadline, status, first_gen_time").eq("voided", false).neq("status", "stamped").order("deadline");
    if (error) setMsg(error.message);
    else setRows(data as Row[]);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  async function run(r: Row) {
    const res = await requestTimestamp(r.subject_table, r.subject_id);
    setMsg(`${r.label}: ${res.message}`);
    load();
  }
  const overdue = rows.filter((r) => r.status === "overdue").length;
  return (
    <div className="card stack">
      <h3>タイムスタンプの状況（未付与・期限後のもの）{overdue > 0 && <span className="error">　期限超過 {overdue}件</span>}</h3>
      {msg && <p className="inactive">{msg}</p>}
      <table>
        <thead><tr><th>対象</th><th>付与期限</th><th>状況</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.subject_id}>
              <td className="wrap">{r.subject_table === "document_files" ? "送付PDF " : "受領書類 "}{r.label}</td><td>{r.deadline}</td>
              <td className={r.status === "overdue" ? "error" : ""}>{TS_STATUS[r.status]}</td>
              <td>{canWrite && r.status !== "stamped_late" && <button className="secondary" onClick={() => run(r)}>付与を実行</button>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4}>未付与・期限後のものはありません</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
