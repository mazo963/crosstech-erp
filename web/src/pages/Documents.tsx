import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { type DocType, DOC_LABEL, type IssuedDoc, openDocument } from "../lib/documents";
import { yen } from "../lib/format";
import { DocumentRecords } from "./DocumentRecords";
import { SendSteps } from "./SendSteps";
import { DocumentView } from "./DocumentView";
import { FitPage } from "./FitPage";

type Row = Pick<IssuedDoc, "id" | "doc_type" | "doc_no" | "version" | "doc_date" | "amount" | "counterparty_name" | "voided">;

/** 発行済み帳票の検索（取引年月日・取引金額・取引先。範囲指定と組合せ可）と、詳細・印刷。 */
export function Documents({ docId, canWrite }: { docId: string | null; canWrite: boolean }) {
  if (docId) return <DocumentDetail id={docId} canWrite={canWrite} />;
  return <DocumentSearch />;
}

function DocumentSearch() {
  const [f, setF] = useState({ type: "", from: "", to: "", min: "", max: "", name: "", no: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    let q = supabase.from("issued_documents").select("id, doc_type, doc_no, version, doc_date, amount, counterparty_name, voided")
      .order("doc_date", { ascending: false }).order("doc_no", { ascending: false }).limit(200);
    if (f.type) q = q.eq("doc_type", f.type);
    if (f.from) q = q.gte("doc_date", f.from);
    if (f.to) q = q.lte("doc_date", f.to);
    if (f.min) q = q.gte("amount", Number(f.min));
    if (f.max) q = q.lte("amount", Number(f.max));
    if (f.name.trim()) q = q.ilike("counterparty_name", `%${f.name.trim()}%`);
    if (f.no.trim()) q = q.ilike("doc_no", `%${f.no.trim()}%`);
    q.then(({ data, error }) => (error ? setError(error.message) : setRows(data as Row[])));
  }, [f]);

  return (
    <div className="card stack">
      <h3>発行済み帳票の検索</h3>
      <div className="grid">
        <label>種類
          <select value={f.type} onChange={(e) => set("type", e.target.value)}>
            <option value="">すべて</option>
            {(Object.keys(DOC_LABEL) as DocType[]).map((t) => <option key={t} value={t}>{DOC_LABEL[t]}</option>)}
          </select>
        </label>
        <label>取引年月日（から）<input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></label>
        <label>取引年月日（まで）<input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></label>
        <label>取引金額（以上）<input type="number" value={f.min} onChange={(e) => set("min", e.target.value)} /></label>
        <label>取引金額（以下）<input type="number" value={f.max} onChange={(e) => set("max", e.target.value)} /></label>
        <label>取引先（一部でも可）<input value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label>帳票番号<input value={f.no} onChange={(e) => set("no", e.target.value)} /></label>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>種類</th><th>番号</th><th>版</th><th>取引年月日</th><th>取引先</th><th>金額</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.voided ? "inactive" : ""}>
              <td>{DOC_LABEL[r.doc_type]}</td><td>{r.doc_no}{r.voided && "（取消）"}</td><td>{r.version}</td><td>{r.doc_date}</td>
              <td>{r.counterparty_name}</td><td>{yen(r.amount)}</td>
              <td><button className="secondary" onClick={() => openDocument(r.id)}>開く</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7}>該当する帳票がありません（最大200件）</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function DocumentDetail({ id, canWrite }: { id: string; canWrite: boolean }) {
  const [doc, setDoc] = useState<IssuedDoc | null>(null);
  const [versions, setVersions] = useState<{ id: string; version: number; issued_at: string; voided: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    supabase.from("issued_documents").select("*").eq("id", id).single().then(async ({ data, error }) => {
      if (error) return setError(error.message);
      const d = data as IssuedDoc;
      setDoc(d);
      const v = await supabase.from("issued_documents").select("id, version, issued_at, voided")
        .eq("doc_type", d.doc_type).eq("source_id", d.source_id).order("version");
      setVersions((v.data as typeof versions) ?? []);
    });
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!doc) return <p>読み込み中…</p>;
  return (
    <div className="split">
    <div className="split-main stack">
      <div className="row no-print">
        <button className="secondary" onClick={() => { window.location.hash = ""; }}>← 検索へ</button>
        <h2>{DOC_LABEL[doc.doc_type]} {doc.doc_no}（版 {doc.version}）</h2>
        <button onClick={() => window.print()}>印刷 / PDFとして保存</button>
      </div>
      {versions.length > 1 && (
        <p className="no-print">この帳票の版: {versions.map((v) => (
          <button key={v.id} className={v.id === id ? "" : "secondary"} onClick={() => openDocument(v.id)}>版{v.version}{v.voided ? "（取消）" : ""}</button>
        ))}</p>
      )}
      <SendSteps doc={doc} />
      <DocumentRecords doc={doc} canWrite={canWrite} />
    </div>
    <aside className="split-side"><FitPage><DocumentView doc={doc} /></FitPage></aside>
    </div>
  );
}
