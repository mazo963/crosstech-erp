import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { DocType } from "../lib/documents";

type Vals = { postal_code: string | null; address: string | null; department: string | null; contact_name: string | null };
type Show = { address: boolean; department: boolean; contact: boolean };
type Resolved = { source: "document" | "quote" | "master"; customer_id: string; values: Vals; show: Show; master: Vals & { show_address: boolean; show_department: boolean; show_contact: boolean } };
type Target = "doc" | "project" | "master";

const SOURCE: Record<Resolved["source"], string> = { document: "この帳票用に変更済み", quote: "この案件の見積書の設定を引き継ぎ", master: "得意先マスタの値" };
const LABEL: Record<DocType, string> = { quote: "見積書", delivery_note: "納品書", invoice: "請求書" };

/** 帳票の宛先（住所・担当部署名・担当者名）。マスタの値を既定に、この帳票だけ変更できる。項目ごとに、表示する／しないを選べる。 */
export function AddresseeEditor({ type, sourceId, projectId, canWrite, rev, onSaved }: {
  type: DocType; sourceId: string; projectId?: string; canWrite: boolean; rev: number; onSaved: () => void;
}) {
  const [r, setR] = useState<Resolved | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ postal_code: "", address: "", department: "", contact_name: "", show_address: true, show_department: true, show_contact: true });
  const [target, setTarget] = useState<Target>("doc");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("resolve_addressee", { p_type: type, p_source_id: sourceId });
    if (error) return setError(error.message);
    const x = data as Resolved;
    setR(x);
    setF({
      postal_code: x.values.postal_code ?? "", address: x.values.address ?? "", department: x.values.department ?? "", contact_name: x.values.contact_name ?? "",
      show_address: x.show.address, show_department: x.show.department, show_contact: x.show.contact,
    });
  }, [type, sourceId]);
  useEffect(() => { setOpen(false); setError(null); load(); }, [load, rev]);

  if (!r) return error ? <p className="error">{error}</p> : null;
  const nul = (s: string) => (s.trim() === "" ? null : s.trim());
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const summary = [
    f.show_address && (f.address || f.postal_code) ? `〒${f.postal_code} ${f.address}`.replace("〒 ", "") : null,
    [f.show_department && f.department, f.show_contact && f.contact_name && `${f.contact_name} 様`].filter(Boolean).join("　") || null,
  ].filter(Boolean);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const row = {
      postal_code: nul(f.postal_code), address: nul(f.address), department: nul(f.department), contact_name: nul(f.contact_name),
      show_address: f.show_address, show_department: f.show_department, show_contact: f.show_contact,
    };
    try {
      const run = async (q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error) throw new Error(error.message); };
      const del = (t: DocType, id: string) => run(supabase.from("doc_addressees").delete().eq("doc_type", t).eq("source_id", id));
      if (target === "doc") {
        await run(supabase.from("doc_addressees").upsert({ doc_type: type, source_id: sourceId, ...row }, { onConflict: "doc_type,source_id" }));
      } else if (target === "project" && projectId) {
        await run(supabase.from("doc_addressees").upsert({ doc_type: "quote", source_id: projectId, ...row }, { onConflict: "doc_type,source_id" }));
        if (type !== "quote") await del(type, sourceId); // この帳票の個別の変更は外し、案件の設定を使う
      } else if (target === "master") {
        await run(supabase.from("customers").update({
          postal_code: row.postal_code, address: row.address, department: row.department, contact_name: row.contact_name,
          show_address: row.show_address, show_department: row.show_department, show_contact: row.show_contact,
        }).eq("id", r!.customer_id));
        await del(type, sourceId);
        if (projectId && type !== "quote") await del("quote", projectId);
        else if (type === "quote") await del("quote", sourceId);
      }
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    setBusy(false);
  }
  async function reset() {
    setBusy(true); setError(null);
    const { error } = await supabase.from("doc_addressees").delete().eq("doc_type", type).eq("source_id", sourceId);
    setBusy(false);
    if (error) return setError(error.message);
    onSaved();
  }

  return (
    <div className="card stack no-print">
      <div className="row">
        <h3>宛先（{LABEL[type]}に表示）</h3>
        {canWrite && !open && <button type="button" className="secondary" onClick={() => setOpen(true)}>変更</button>}
      </div>
      <p>{summary.length ? summary.map((l, i) => <span key={i} className="addr-line">{l}</span>) : <span className="inactive">会社名のみ（住所・担当部署・担当者は表示しません）</span>}</p>
      <p className="inactive">{SOURCE[r.source]}</p>
      {open && canWrite && (
        <form className="stack" onSubmit={save}>
          <div className="addr-grid">
            <label className="check"><input type="checkbox" checked={f.show_address} onChange={(e) => set("show_address", e.target.checked)} />住所を表示</label>
            <div className="addr-fields"><input value={f.postal_code} onChange={(e) => set("postal_code", e.target.value)} placeholder="郵便番号" style={{ maxWidth: 110 }} disabled={!f.show_address} />
              <input value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="住所" disabled={!f.show_address} /></div>
            <label className="check"><input type="checkbox" checked={f.show_department} onChange={(e) => set("show_department", e.target.checked)} />担当部署を表示</label>
            <input value={f.department} onChange={(e) => set("department", e.target.value)} placeholder="担当部署名" disabled={!f.show_department} />
            <label className="check"><input type="checkbox" checked={f.show_contact} onChange={(e) => set("show_contact", e.target.checked)} />担当者を表示</label>
            <input value={f.contact_name} onChange={(e) => set("contact_name", e.target.value)} placeholder="担当者名（「様」は自動で付きます）" disabled={!f.show_contact} />
          </div>
          <div className="stack">
            <span className="inactive">保存先</span>
            <label className="check"><input type="radio" checked={target === "doc"} onChange={() => setTarget("doc")} />この{LABEL[type]}だけ</label>
            {projectId && <label className="check"><input type="radio" checked={target === "project"} onChange={() => setTarget("project")} />この案件の見積書・納品書・請求書すべて</label>}
            <label className="check"><input type="radio" checked={target === "master"} onChange={() => setTarget("master")} />得意先マスタにも反映（今後の新しい帳票の既定になります）</label>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="row wrap">
            <button disabled={busy}>{busy ? "保存中…" : "保存"}</button>
            {r.source === "document" && <button type="button" className="secondary" disabled={busy} onClick={reset}>この帳票の変更をやめて、マスタの値に戻す</button>}
            <button type="button" className="secondary" onClick={() => { setOpen(false); load(); }}>キャンセル</button>
          </div>
          <p className="inactive">非表示にした項目は、値を残したまま印刷されなくなります。発行済みの帳票は変わりません（再発行すると新しい版になります）。</p>
        </form>
      )}
      {!open && error && <p className="error">{error}</p>}
    </div>
  );
}
