import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { AddresseeEditor } from "./AddresseeEditor";
import { DocPreview } from "./DocPreview";
import { IssueButton } from "./IssueButton";

type Dv = { id: string; delivery_no: string };

/** 案件の画面の右側: 見積書と各納品書の発行イメージ。内容は保存済みのもの（保存・変換のたびに更新）。 */
export function ProjectPreview({ projectId, rev, canWrite }: { projectId: string; rev: number; canWrite: boolean }) {
  const [deliveries, setDeliveries] = useState<Dv[]>([]);
  const [sel, setSel] = useState<string>("quote");
  const [local, setLocal] = useState(0); // 宛先を保存したら、発行イメージを更新する

  useEffect(() => {
    supabase.from("v_delivery_list").select("id, delivery_no").eq("project_id", projectId).eq("voided", false).order("delivered_on")
      .then(({ data }) => setDeliveries((data as Dv[]) ?? []));
  }, [projectId, rev]);

  const cur = sel === "quote" ? null : deliveries.find((d) => d.id === sel) ?? null;
  const type = cur ? "delivery_note" : "quote";
  const sourceId = cur ? cur.id : projectId;
  return (
    <div className="card stack no-print-keep">
      <div className="preview-bar">
        <div className="tabs">
          <button className={sel === "quote" ? "" : "secondary"} onClick={() => setSel("quote")}>見積書</button>
          {deliveries.map((d) => <button key={d.id} className={sel === d.id ? "" : "secondary"} onClick={() => setSel(d.id)}>納品書 {d.delivery_no}</button>)}
        </div>
        {canWrite && <IssueButton type={type} sourceId={sourceId} label="発行して固定・表示" />}
      </div>
      <p className="inactive">発行イメージ（保存済みの内容）。発行すると内容が固定され、印刷・PDF保存・交付の記録ができます。</p>
      <AddresseeEditor type={type} sourceId={sourceId} projectId={projectId} canWrite={canWrite} rev={rev + local} onSaved={() => setLocal((n) => n + 1)} />
      <DocPreview type={type} sourceId={sourceId} rev={rev + local} />
    </div>
  );
}
