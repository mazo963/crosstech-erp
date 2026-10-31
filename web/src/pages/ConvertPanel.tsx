import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { go } from "../lib/nav";
import { type DocType, openDocument } from "../lib/documents";
import { IssueButton } from "./IssueButton";

type Info = { items: number; remaining: number; deliveries: number; unbilled: number; quote: { version: number } | null };

/** 見積書 → 受注 → 納品書 → 請求書 を、ボタンで順に変換する。変換は保存済みの内容で行う（金額・税の計算はDB）。 */
export function ConvertPanel({ projectId, status, canWrite, onChanged }: { projectId: string; status: string; canWrite: boolean; onChanged: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [it, dl, ub, q] = await Promise.all([
      supabase.from("v_item_progress").select("remaining_qty").eq("project_id", projectId),
      supabase.from("v_delivery_list").select("id").eq("project_id", projectId).eq("voided", false),
      supabase.from("v_unbilled_lines").select("delivery_line_id").eq("project_id", projectId),
      supabase.from("issued_documents").select("version").eq("doc_type", "quote").eq("source_id", projectId).order("version", { ascending: false }).limit(1),
    ]);
    const items = (it.data as { remaining_qty: number }[]) ?? [];
    setInfo({
      items: items.length, remaining: items.filter((x) => Number(x.remaining_qty) > 0).length,
      deliveries: dl.data?.length ?? 0, unbilled: ub.data?.length ?? 0, quote: (q.data as { version: number }[])?.[0] ?? null,
    });
  }, [projectId]);
  useEffect(() => { load(); }, [load, status]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
    load(); onChanged();
  }
  const rpc = async <T,>(fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  };

  const order = () => run(async () => { await rpc("order_project", { p_project_id: projectId }); });
  const toDelivery = () => run(async () => {
    const deliveryId = await rpc<string>("deliver_all", { p_project_id: projectId, p_delivered_on: date });
    const docId = await rpc<string>("issue_document", { p_type: "delivery_note" satisfies DocType, p_source_id: deliveryId }); // 納品書を発行（内容を固定）して開く
    openDocument(docId);
  });
  const toInvoice = () => run(async () => {
    const id = await rpc<string>("create_invoice_for_project", { p_project_id: projectId });
    go("invoice", id);
  });

  if (!info) return null;
  const closed = status === "lost" || status === "closed";
  const steps = [
    { n: 1, label: "見積書", state: info.quote ? `発行済み（版${info.quote.version}）` : "未発行" },
    { n: 2, label: "受注", state: status === "estimate" ? "見積中" : closed ? (status === "lost" ? "失注" : "完了") : "受注済み" },
    { n: 3, label: "納品書", state: info.items === 0 ? "品目なし" : info.remaining === 0 ? `全数納品済み（${info.deliveries}回）` : `納品${info.deliveries}回・残りの品目あり` },
    { n: 4, label: "請求書", state: info.unbilled > 0 ? `未請求の納品あり` : info.deliveries > 0 ? "請求済み" : "納品なし" },
  ];
  return (
    <div className="card stack no-print">
      <h3>見積書から、そのまま納品書・請求書へ</h3>
      <div className="steps">
        {steps.map((s) => <div key={s.n} className="step"><span>{s.n}. {s.label}</span><strong>{s.state}</strong></div>)}
      </div>
      {canWrite && (
        <div className="row wrap">
          <IssueButton type="quote" sourceId={projectId} label="① 見積書を発行・表示" />
          <button type="button" disabled={busy || status !== "estimate" || info.items === 0} onClick={order}>② 受注にする</button>
          <label className="check">納品日<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button type="button" disabled={busy || closed || info.remaining === 0} onClick={toDelivery}>③ 納品書にする（残りを全数納品）</button>
          <button type="button" disabled={busy || info.unbilled === 0} onClick={toInvoice}>④ 請求書にする（未請求の納品をまとめて）</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <p className="inactive">
        変換は<strong>保存済みの内容</strong>で行います。見積中のまま③を押すと、自動で受注になります。数量や日付を変えて分納するときは、下の「分納」で記録してください。
        複数の案件を月末にまとめて請求するときは、「請求」タブの「締め請求を作成」を使います。
      </p>
    </div>
  );
}
