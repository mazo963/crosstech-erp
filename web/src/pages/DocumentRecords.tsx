import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { IssuedDoc } from "../lib/documents";
import { bytesToBase64, generatePdf } from "../lib/docPdfClient";
import { saveBlob } from "../lib/download";
import { requestTimestamp } from "../lib/timestamp";
import { useSettings } from "../lib/useSettings";

type Delivery = { id: string; method: string; delivered_on: string; recipient: string | null; note: string | null };
type FileRow = { id: string; delivery_id: string | null; file_name: string; size_bytes: number; sha256: string };

const METHOD: Record<string, string> = { paper: "紙（郵送・手渡し）", email_pdf: "PDF（メール）", box: "Box保存", other: "その他" };

/** 交付の記録（追記のみ）。PDFで送ったときは、このシステムが作ったPDFを保存する。Box保存も記録する。 */
export function DocumentRecords({ doc, canWrite, onChanged }: { doc: IssuedDoc; canWrite: boolean; onChanged?: () => void }) {
  const { settings } = useSettings();
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [method, setMethod] = useState("email_pdf");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [alt, setAlt] = useState<File | null>(null);
  const [boxToo, setBoxToo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, f] = await Promise.all([
      supabase.from("document_deliveries").select("id, method, delivered_on, recipient, note").eq("document_id", doc.id).order("created_at"),
      supabase.from("document_files").select("id, delivery_id, file_name, size_bytes, sha256").eq("document_id", doc.id).order("uploaded_at"),
    ]);
    if (d.error || f.error) return setError((d.error ?? f.error)!.message);
    setDeliveries(d.data as Delivery[]);
    setFiles(f.data as FileRow[]);
  }, [doc.id]);
  useEffect(() => { load(); }, [load]);

  async function record(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const ins = await supabase.from("document_deliveries")
        .insert({ document_id: doc.id, method, delivered_on: date, recipient: recipient.trim() || null, note: note.trim() || null }).select("id").single();
      if (ins.error) throw new Error(ins.error.message);
      if (method === "email_pdf") {
        // 送付したPDF: 別のPDFを選んだ場合はそれ、なければこのシステムが作ったPDF（ダウンロードしたものと同じ内容）
        const pdf = alt ? { b64: bytesToBase64(new Uint8Array(await alt.arrayBuffer())), name: alt.name } : await generatePdf(doc).then((r) => ({ b64: bytesToBase64(r.bytes), name: r.fileName }));
        const up = await supabase.rpc("attach_document_pdf", { p_document_id: doc.id, p_delivery_id: ins.data.id, p_file_name: pdf.name, p_base64: pdf.b64 });
        if (up.error) throw new Error(`交付は記録しましたが、PDFを保存できませんでした: ${up.error.message}`);
        if (settings?.own_timestamp) {
          const ts = await requestTimestamp("document_files", up.data as string);
          if (!ts.ok) setError(`PDFは保存しました。タイムスタンプは保留です: ${ts.message}`);
        }
        if (boxToo) {
          const bx = await supabase.from("document_deliveries").insert({ document_id: doc.id, method: "box", delivered_on: date, recipient: settings?.box_import_email ?? "Box", note: `PDF: ${pdf.name}` });
          if (bx.error) throw new Error(`Box保存の記録に失敗しました: ${bx.error.message}`);
        }
      }
      setRecipient(""); setNote(""); setAlt(null);
      await load(); onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); await load(); }
    setBusy(false);
  }

  async function download(f: FileRow) {
    const { data, error } = await supabase.rpc("document_file_base64", { p_file_id: f.id });
    if (error || typeof data !== "string") return setError(error?.message ?? "取得できません");
    saveBlob(Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)) as unknown as BlobPart, f.file_name, "application/pdf");
  }

  return (
    <div className="card stack no-print">
      <h3>交付の記録</h3>
      <div className="tablewrap"><table>
        <thead><tr><th>交付日</th><th>方法</th><th>宛先</th><th>メモ</th><th>保存したPDF</th></tr></thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td>{d.delivered_on}</td><td>{METHOD[d.method]}</td><td className="wrap">{d.recipient ?? ""}</td><td className="wrap">{d.note ?? ""}</td>
              <td>{files.filter((f) => f.delivery_id === d.id).map((f) => <button key={f.id} type="button" className="secondary" onClick={() => download(f)}>{f.file_name}（{f.sha256.slice(0, 12)}）</button>)}</td>
            </tr>
          ))}
          {deliveries.length === 0 && <tr><td colSpan={5}>交付の記録はありません</td></tr>}
        </tbody>
      </table></div>
      {canWrite && !doc.voided && (
        <form onSubmit={record} className="stack">
          <div className="grid">
            <label>交付方法
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(METHOD).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
            <label>交付日<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
            <label>宛先（メールアドレス・担当者など）<input value={recipient} onChange={(e) => setRecipient(e.target.value)} /></label>
            <label>メモ<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
            {method === "email_pdf" && <label>別のPDFを送った場合のみ選択（通常は不要）<input type="file" accept="application/pdf" onChange={(e) => setAlt(e.target.files?.[0] ?? null)} /></label>}
            {method === "email_pdf" && <label className="check"><input type="checkbox" checked={boxToo} onChange={(e) => setBoxToo(e.target.checked)} /> Box にも保存した（Box宛にも同じPDFを送った）</label>}
          </div>
          {method === "email_pdf" && <p className="inactive">「PDF（メール）」を記録すると、<strong>このシステムが作ったPDFを、送付したPDFとして保存</strong>します（内容のハッシュをDBが記録。後から差替え・削除はできません）。必ず、ダウンロードしたPDFを添付して送ってください。</p>}
          {error && <p className="error">{error}</p>}
          <div><button disabled={busy}>{busy ? "記録中…" : "交付を記録"}</button></div>
        </form>
      )}
      {!canWrite && error && <p className="error">{error}</p>}
    </div>
  );
}
