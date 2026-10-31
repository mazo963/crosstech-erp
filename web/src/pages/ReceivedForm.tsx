import { useState } from "react";
import { supabase } from "../lib/supabase";
import { requestTimestamp } from "../lib/timestamp";

export const CATEGORY: [string, string][] = [
  ["invoice", "請求書"], ["receipt", "領収書"], ["delivery_note", "納品書"], ["quote", "見積書"],
  ["order", "注文書"], ["contract", "契約書"], ["other", "その他"],
];
const CHANNEL: [string, string][] = [["email", "メール"], ["web", "Webサイト・クラウド"], ["edi", "EDI"], ["cloud", "クラウドサービス"], ["other", "その他"]];
const today = () => new Date().toISOString().slice(0, 10);

/** 受領書類の登録（電子取引 / スキャナ保存）。条件・期限・ハッシュの判定はDB。登録後にタイムスタンプを自動で依頼する。 */
export function ReceivedForm({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({
    kind: "electronic", doc_category: "invoice", doc_date: today(), amount: "", counterparty_name: "", related_ref: "",
    received_on: today(), channel: "email", scanned_on: today(), resolution_dpi: "300", color_mode: "color", page_size: "A4", page_count: "1",
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const scanned = f.kind === "scanned";
  const important = f.doc_category !== "quote" && f.doc_category !== "order"; // 見積書・注文書は一般書類、それ以外は重要書類（スキャナ保存 問10）

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("ファイルを選択してください");
    if (file.size > 10 * 1024 * 1024) return setError("ファイルは10MBまでです");
    setBusy(true);
    setError(null);
    const meta = {
      kind: f.kind, doc_category: f.doc_category, doc_date: f.doc_date, amount: Number(f.amount), counterparty_name: f.counterparty_name,
      related_ref: f.related_ref, received_on: f.received_on, file_name: file.name, mime_type: file.type,
      ...(scanned
        ? { scanned_on: f.scanned_on, resolution_dpi: Number(f.resolution_dpi), color_mode: important ? "color" : f.color_mode, page_size: f.page_size, page_count: Number(f.page_count) }
        : { channel: f.channel }),
    };
    const { data, error } = await supabase.rpc("register_received_document", { p_meta: meta, p_base64: await toBase64(file) });
    if (error) { setBusy(false); return setError(error.message); }
    const ts = await requestTimestamp("received_documents", data as string);
    setBusy(false);
    onDone(`登録しました。タイムスタンプ: ${ts.ok ? ts.message : `保留（${ts.message}）`}`);
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h3>受領書類を登録</h3>
      <div className="row">
        <label className="check"><input type="radio" checked={!scanned} onChange={() => set("kind", "electronic")} /> 電子データで受け取った（メール・Web等）</label>
        <label className="check"><input type="radio" checked={scanned} onChange={() => set("kind", "scanned")} /> 紙を読み取って保存する（スキャナ保存）</label>
      </div>
      <div className="grid">
        <label>書類の種類 *<select value={f.doc_category} onChange={(e) => set("doc_category", e.target.value)}>{CATEGORY.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <label>取引年月日 *<input type="date" value={f.doc_date} onChange={(e) => set("doc_date", e.target.value)} required /></label>
        <label>取引金額（税込・円） *<input type="number" step="1" value={f.amount} onChange={(e) => set("amount", e.target.value)} required /></label>
        <label>取引先 *<input value={f.counterparty_name} onChange={(e) => set("counterparty_name", e.target.value)} required /></label>
        <label>授受日（受け取った日） *<input type="date" value={f.received_on} onChange={(e) => set("received_on", e.target.value)} required /></label>
        <label>関連する帳簿の伝票番号<input value={f.related_ref} onChange={(e) => set("related_ref", e.target.value)} placeholder="外注仕入の請求書番号など。未作成なら後から紐づけ" /></label>
        {!scanned && <label>受け取った方法 *<select value={f.channel} onChange={(e) => set("channel", e.target.value)}>{CHANNEL.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>}
        {scanned && (
          <>
            <label>読み取った日 *<input type="date" value={f.scanned_on} onChange={(e) => set("scanned_on", e.target.value)} required /></label>
            <label>解像度（dpi・200以上） *<input type="number" min="200" value={f.resolution_dpi} onChange={(e) => set("resolution_dpi", e.target.value)} required /></label>
            <label>色 *<select value={important ? "color" : f.color_mode} onChange={(e) => set("color_mode", e.target.value)} disabled={important}><option value="color">カラー（24ビット）</option>{!important && <option value="grayscale">グレースケール（一般書類のみ）</option>}</select></label>
            <label>用紙サイズ<input value={f.page_size} onChange={(e) => set("page_size", e.target.value)} /></label>
            <label>ページ数 *<input type="number" min="1" value={f.page_count} onChange={(e) => set("page_count", e.target.value)} required /></label>
          </>
        )}
        <label>ファイル *<input type="file" accept={scanned ? "application/pdf,image/png,image/jpeg,image/tiff" : undefined} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      </div>
      {scanned && <p className="inactive">重要書類（契約書・納品書・請求書・領収書など）はカラー（24ビット）・200dpi以上で読み取り、授受日から7営業日以内（事務処理規程があれば最長2か月＋7営業日以内）に登録してください。重要書類は、関連する帳簿への紐づけが必要です（帳簿が未作成なら、作成後に一覧から紐づけます）。期間を過ぎた重要書類は、紙の原本を保存し続ける必要があります。見積書・注文書などの一般書類はグレースケールも可です。原本の廃棄は、登録とタイムスタンプの付与を確認してから行ってください。</p>}
      {error && <p className="error">{error}</p>}
      <div className="row"><button disabled={busy}>{busy ? "登録中…" : "登録"}</button><button type="button" className="secondary" onClick={onCancel}>キャンセル</button></div>
    </form>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("ファイルを読み込めません"));
    r.readAsDataURL(file);
  });
}
