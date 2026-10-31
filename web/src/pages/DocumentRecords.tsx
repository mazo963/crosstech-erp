import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Delivery = { id: string; method: string; delivered_on: string; recipient: string | null; note: string | null };
type FileRow = { id: string; delivery_id: string | null; file_name: string; size_bytes: number; sha256: string; uploaded_at: string };

const METHOD: Record<string, string> = { paper: "紙（郵送・手渡し）", email_pdf: "PDF（メール等）", other: "その他" };

/** 交付の記録と、送付したPDFそのものの保存（電子取引データ）。記録・PDFは追記のみで、修正や削除はできない。 */
export function DocumentRecords({ documentId, voided, canWrite }: { documentId: string; voided: boolean; canWrite: boolean }) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [method, setMethod] = useState("paper");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, f] = await Promise.all([
      supabase.from("document_deliveries").select("id, method, delivered_on, recipient, note").eq("document_id", documentId).order("created_at"),
      supabase.from("document_files").select("id, delivery_id, file_name, size_bytes, sha256, uploaded_at").eq("document_id", documentId).order("uploaded_at"),
    ]);
    if (d.error || f.error) return setError((d.error ?? f.error)!.message);
    setDeliveries(d.data as Delivery[]);
    setFiles(f.data as FileRow[]);
  }, [documentId]);
  useEffect(() => { load(); }, [load]);

  async function record(e: React.FormEvent) {
    e.preventDefault();
    if (method === "email_pdf" && !pdf) return setError("PDFで送付した場合は、送ったPDFファイルを選択してください（そのまま保存します）");
    setBusy(true);
    setError(null);
    const ins = await supabase.from("document_deliveries")
      .insert({ document_id: documentId, method, delivered_on: date, recipient: recipient.trim() || null, note: note.trim() || null })
      .select("id").single();
    if (ins.error) { setBusy(false); return setError(ins.error.message); }
    if (pdf) {
      const b64 = await toBase64(pdf);
      const up = await supabase.rpc("attach_document_pdf", { p_document_id: documentId, p_delivery_id: ins.data.id, p_file_name: pdf.name, p_base64: b64 });
      if (up.error) setError(`交付は記録しましたが、PDFを保存できませんでした: ${up.error.message}`);
    }
    setBusy(false);
    setPdf(null); setRecipient(""); setNote("");
    load();
  }

  async function download(f: FileRow) {
    const { data, error } = await supabase.rpc("document_file_base64", { p_file_id: f.id });
    if (error || typeof data !== "string") return setError(error?.message ?? "取得できません");
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    a.download = f.file_name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="card stack no-print">
      <h3>交付の記録・送付したPDF</h3>
      <table>
        <thead><tr><th>交付日</th><th>方法</th><th>宛先</th><th>メモ</th><th>保存したPDF（SHA-256 先頭12桁）</th></tr></thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td>{d.delivered_on}</td><td>{METHOD[d.method]}</td><td>{d.recipient ?? ""}</td><td>{d.note ?? ""}</td>
              <td>{files.filter((f) => f.delivery_id === d.id).map((f) => (
                <button key={f.id} type="button" className="secondary" onClick={() => download(f)}>{f.file_name}（{f.sha256.slice(0, 12)}）</button>
              ))}</td>
            </tr>
          ))}
          {deliveries.length === 0 && <tr><td colSpan={5}>交付の記録はありません</td></tr>}
        </tbody>
      </table>
      {canWrite && !voided && (
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
            <label>送付したPDF{method === "email_pdf" && " *"}
              <input type="file" accept="application/pdf" onChange={(e) => setPdf(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <p className="inactive">PDFで送った場合は、送ったファイルそのものを選択してください。内容のハッシュをDBが記録し、後から差し替えや削除はできません。</p>
          {error && <p className="error">{error}</p>}
          <div><button disabled={busy}>{busy ? "記録中…" : "交付を記録"}</button></div>
        </form>
      )}
      {!canWrite && error && <p className="error">{error}</p>}
    </div>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("PDFを読み込めません"));
    r.readAsDataURL(file);
  });
}
