import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { pct, yen } from "../lib/format";
import {
  type AiResult, type HeadForm, type ItemForm, STATUS, emptyHead, emptyItem, headPayload, itemFromRow, itemPayload,
} from "../lib/projects";
import { AiImport } from "./AiImport";
import { Deliveries } from "./Deliveries";
import { ConvertPanel } from "./ConvertPanel";
import { ProjectPreview } from "./ProjectPreview";
import { ItemsEditor } from "./ItemsEditor";

type Opt = { id: string; name: string };
type Summary = { sales_amount: number; cost_amount: number; gross_profit: number; margin_pct: number | null; project_no: string };

export function ProjectEdit({ id, myId, canWrite, onBack }: {
  id: string | null; myId: string; canWrite: boolean; onBack: () => void;
}) {
  const [projectId, setProjectId] = useState<string | null>(id);
  const [head, setHead] = useState<HeadForm>(emptyHead(myId));
  const [items, setItems] = useState<ItemForm[]>([]);
  const [origIds, setOrigIds] = useState<string[]>([]);
  const [customers, setCustomers] = useState<Opt[]>([]);
  const [vendors, setVendors] = useState<Opt[]>([]);
  const [staff, setStaff] = useState<Opt[]>([]);
  const [taxCategories, setTaxCategories] = useState<{ code: string; name: string }[]>([{ code: "standard", name: "標準税率" }]);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [summary, setSummary] = useState<Summary | null>(null);
  const [ai, setAi] = useState<AiResult | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0); // 保存・変換のたびに増やし、発行イメージを更新する

  async function load(pid: string) {
    const [p, it, sm] = await Promise.all([
      supabase.from("projects").select("*").eq("id", pid).single(),
      supabase.from("v_item_progress").select("*").eq("project_id", pid).order("line_no"),
      supabase.from("v_project_summary").select("project_no, sales_amount, cost_amount, gross_profit, margin_pct").eq("id", pid).single(),
    ]);
    if (p.error || it.error) return setError((p.error ?? it.error)!.message);
    const s = (v: unknown) => (v == null ? "" : String(v));
    const r = p.data as Record<string, unknown>;
    setHead({
      customer_id: s(r.customer_id), lead_staff_id: s(r.lead_staff_id), title: s(r.title), customer_po_no: s(r.customer_po_no),
      status: s(r.status), estimate_date: s(r.estimate_date), order_date: s(r.order_date), due_date: s(r.due_date),
      notes: s(r.notes), internal_memo: s(r.internal_memo),
    });
    const rows = it.data as Record<string, unknown>[];
    setItems(rows.map(itemFromRow));
    setOrigIds(rows.map((x) => x.id as string));
    setAmounts(Object.fromEntries(rows.map((x) => [x.id as string, Number(x.sale_amount)])));
    setSummary(sm.data as Summary | null);
    setRev((n) => n + 1);
  }

  useEffect(() => {
    supabase.from("customers").select("id, name").eq("active", true).order("name").then((r) => setCustomers((r.data as Opt[]) ?? []));
    supabase.from("vendors").select("id, name").eq("active", true).order("name").then((r) => setVendors((r.data as Opt[]) ?? []));
    supabase.from("staff").select("id, name").eq("active", true).order("name").then((r) => setStaff((r.data as Opt[]) ?? []));
    supabase.from("tax_categories").select("code, name").eq("active", true).order("sort_order").then((r) => r.data && setTaxCategories(r.data));
    if (id) load(id);
  }, [id]);

  const setH = (k: keyof HeadForm, v: string) => setHead((p) => ({ ...p, [k]: v }));

  // AIの結果は入力欄に下書きとして入れるだけ。得意先は候補を示すのみで自動確定しない
  function applyAi(r: AiResult) {
    const d = r.draft;
    setAi(r);
    setAiOpen(false);
    setHead((p) => ({
      ...p, title: p.title || d.title, customer_po_no: p.customer_po_no || d.customer_po_no || "",
      due_date: p.due_date || d.due_date || "", notes: p.notes || d.notes || "", internal_memo: p.internal_memo || d.internal_memo || "",
    }));
    const added = d.items.map((x) => ({
      ...emptyItem(), name: x.name, customer_part_no: x.customer_part_no ?? "", spec: x.spec ?? "", quantity: String(x.quantity),
      unit: x.unit ?? "個", sale_unit_price: String(x.sale_unit_price ?? 0), due_date: x.due_date ?? "",
    }));
    setItems((p) => [...p, ...added]);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!head.customer_id) return setError("得意先を選択してください");
    setBusy(true);
    setError(null);
    try {
      let pid = projectId;
      if (pid) {
        const { error } = await supabase.from("projects").update(headPayload(head)).eq("id", pid);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("projects")
          .insert({ ...headPayload(head), source: ai ? "ai" : "manual" }).select("id").single();
        if (error) throw error;
        pid = data.id as string;
        setProjectId(pid);
        if (ai) await supabase.from("ai_extractions").update({ applied_project_id: pid }).eq("id", ai.extraction_id);
      }
      for (const it of items) {
        const q = it.id
          ? supabase.from("project_items").update(itemPayload(it)).eq("id", it.id)
          : supabase.from("project_items").insert({ ...itemPayload(it), project_id: pid });
        const { error } = await q;
        if (error) throw error;
      }
      const removed = origIds.filter((oid) => !items.some((it) => it.id === oid));
      if (removed.length) {
        const { error } = await supabase.from("project_items").delete().in("id", removed);
        if (error) throw error;
      }
      setAi(null);
      await load(pid);
    } catch (err) {
      // 途中まで保存されている場合があるため、画面を読み直して実際の状態を見せる
      setError((err as { message?: string }).message ?? String(err));
      if (projectId) await load(projectId);
    }
    setBusy(false);
  }

  const ro = !canWrite;
  return (
    <div className="split">
    <div className="split-main stack">
    <form onSubmit={save} className="stack">
      <div className="row">
        <button type="button" className="secondary" onClick={onBack}>← 一覧へ</button>
        <h2>{summary?.project_no ?? "新規案件"}</h2>
        {canWrite && <button type="button" onClick={() => setAiOpen(true)}>AIで取込</button>}
      </div>
      {projectId && <ConvertPanel projectId={projectId} status={head.status} canWrite={canWrite} onChanged={() => load(projectId)} />}
      {aiOpen && <AiImport onResult={applyAi} onClose={() => setAiOpen(false)} />}
      {ai && (
        <div className="card notice">
          AIの下書きを入力しました（{ai.model}）。内容を確認・修正してから保存してください。
          {ai.draft.customer_name && <> 依頼元の記載: <strong>{ai.draft.customer_name}</strong>。</>}
          {ai.customer_candidates.length > 0 && <> 得意先候補: {ai.customer_candidates.map((c) => (
            <button key={c.id} type="button" className="secondary" onClick={() => setH("customer_id", c.id)}>{c.name}</button>
          ))}</>}
          {ai.customer_candidates.length === 0 && " 一致する得意先がありません。マスタに登録してから選択してください。"}
        </div>
      )}
      <div className="card form">
        <div className="grid">
          <label>得意先 *
            <select value={head.customer_id} onChange={(e) => setH("customer_id", e.target.value)} disabled={ro} required>
              <option value="">選択してください</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>案件名 *<input value={head.title} onChange={(e) => setH("title", e.target.value)} disabled={ro} required /></label>
          <label>客先注文番号<input value={head.customer_po_no} onChange={(e) => setH("customer_po_no", e.target.value)} disabled={ro} /></label>
          <label>状態
            <select value={head.status} onChange={(e) => setH("status", e.target.value)} disabled={ro}>
              {STATUS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </label>
          <label>担当
            <select value={head.lead_staff_id} onChange={(e) => setH("lead_staff_id", e.target.value)} disabled={ro}>
              <option value="">未設定</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>見積日<input type="date" value={head.estimate_date} onChange={(e) => setH("estimate_date", e.target.value)} disabled={ro} /></label>
          <label>受注日<input type="date" value={head.order_date} onChange={(e) => setH("order_date", e.target.value)} disabled={ro} /></label>
          <label>納期<input type="date" value={head.due_date} onChange={(e) => setH("due_date", e.target.value)} disabled={ro} /></label>
        </div>
        <label>備考（帳票に印字）<textarea rows={2} value={head.notes} onChange={(e) => setH("notes", e.target.value)} disabled={ro} /></label>
        <label>社内メモ（帳票に出ません）<textarea rows={2} value={head.internal_memo} onChange={(e) => setH("internal_memo", e.target.value)} disabled={ro} /></label>
      </div>
      <ItemsEditor items={items} vendors={vendors} taxCategories={taxCategories} amounts={amounts} readOnly={ro} onChange={setItems} />
      {summary && (
        <div className="card row">
          <span>売上 {yen(summary.sales_amount)}</span><span>原価 {yen(summary.cost_amount)}</span>
          <span>粗利 {yen(summary.gross_profit)}（{pct(summary.margin_pct)}）</span>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {canWrite && <div className="row"><button disabled={busy}>{busy ? "保存中…" : "保存"}</button></div>}
    </form>
    {projectId && <Deliveries projectId={projectId} status={head.status} canWrite={canWrite} onChanged={() => load(projectId)} />}
    </div>
    <aside className="split-side">
      {projectId ? <ProjectPreview projectId={projectId} rev={rev} canWrite={canWrite} /> : <div className="card inactive">案件を保存すると、ここに見積書・納品書の発行イメージが表示されます。</div>}
    </aside>
    </div>
  );
}
