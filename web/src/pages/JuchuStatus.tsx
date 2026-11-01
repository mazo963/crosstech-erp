import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { jst } from "../lib/format";
import { juchuState } from "../lib/juchu";

type Row = { id: string; line_no: number; product_no: string | null; name: string; juchu_completed_at: string | null; juchu_shipped_date: string | null; juchu_synced_at: string | null };

/** 案件の品目ごとの加工状況（受注システムから同期した値。ここでは編集できない）。 */
export function JuchuStatus({ projectId, rev }: { projectId: string; rev: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    supabase.from("project_items").select("id, line_no, product_no, name, juchu_completed_at, juchu_shipped_date, juchu_synced_at")
      .eq("project_id", projectId).order("line_no").then(({ data }) => setRows((data as Row[]) ?? []));
  }, [projectId, rev]);
  if (rows.length === 0) return null;
  return (
    <div className="card stack">
      <h3>加工状況（受注システムから同期）</h3>
      <div className="tablewrap"><table>
        <thead><tr><th>製番</th><th>品名</th><th>状況</th><th>最終同期</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const s = juchuState(r.juchu_completed_at, r.juchu_shipped_date, r.juchu_synced_at);
            return <tr key={r.id}><td>{r.product_no}</td><td>{r.name}</td><td className={`juchu-${s.tone}`}>{s.label}</td><td>{r.juchu_synced_at ? jst(r.juchu_synced_at) : ""}</td></tr>;
          })}
        </tbody>
      </table></div>
      <p className="inactive">受注システムにある製番だけが同期されます。変更は受注システム側で行い、同期ボタンで反映します。</p>
    </div>
  );
}
