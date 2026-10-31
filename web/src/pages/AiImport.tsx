import { useState } from "react";
import { supabase } from "../lib/supabase";
import type { AiResult } from "../lib/projects";

/** メール本文の貼り付け / 注文書PDF → ai-extract を呼ぶ。結果は下書きとして親に渡すだけで、保存はしない。 */
export function AiImport({ onResult, onClose }: { onResult: (r: AiResult) => void; onClose: () => void }) {
  const [kind, setKind] = useState<"email" | "po_pdf">("email");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const body = kind === "email"
        ? { source_type: kind, text, advanced }
        : { source_type: kind, pdf_base64: await toBase64(file!) };
      const { data, error } = await supabase.functions.invoke("ai-extract", { body });
      if (error) {
        const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
        throw new Error(detail?.error ?? error.message);
      }
      onResult(data as AiResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const ready = kind === "email" ? text.trim() !== "" : file !== null;
  return (
    <div className="card form">
      <h3>AIで取込（下書きを作ります。保存前に必ず内容を確認してください）</h3>
      <div className="row">
        <label className="check"><input type="radio" checked={kind === "email"} onChange={() => setKind("email")} /> 見積依頼メール</label>
        <label className="check"><input type="radio" checked={kind === "po_pdf"} onChange={() => setKind("po_pdf")} /> 注文書PDF</label>
      </div>
      {kind === "email" ? (
        <>
          <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="メール本文を貼り付け" />
          <label className="check"><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> 難しい内容なので高精度モデルを使う</label>
        </>
      ) : (
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button disabled={busy || !ready} onClick={run}>{busy ? "読み取り中…" : "読み取る"}</button>
        <button className="secondary" onClick={onClose}>閉じる</button>
      </div>
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
