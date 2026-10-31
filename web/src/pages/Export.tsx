import { useState } from "react";
import { supabase } from "../lib/supabase";
import { type Cell, toCsv } from "../lib/csv";
import { type ZipEntry, makeZip } from "../lib/zip";
import { ISSUED_COLS, RECEIVED_COLS, SENT_COLS, type Col, rowsOf, safeName, uniquePaths } from "../lib/exportColumns";
import type { IssuedDoc } from "../lib/documents";

type Row = Record<string, unknown>;
const MAX_BYTES = 300 * 1024 * 1024;

function save(data: BlobPart, name: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const sha256Hex = async (b: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

/** 税務調査の「ダウンロードの求め」への出力。一覧CSV（検索項目つき）と、ファイル本体のZIP。形式・並び順は問われないが、通常出力できる形式で出す（国税庁 電子取引 問59）。 */
export function Export({ who }: { who: string }) {
  const [f, setF] = useState({ from: "", to: "", voided: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function fetchAll(view: string): Promise<Row[]> {
    const out: Row[] = [];
    for (let from = 0; ; from += 1000) {
      let q = supabase.from(view).select("*").order("doc_date").order("id").range(from, from + 999);
      if (f.from) q = q.gte("doc_date", f.from);
      if (f.to) q = q.lte("doc_date", f.to);
      if (!f.voided) q = q.eq("voided", false);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      out.push(...(data as Row[]));
      if ((data?.length ?? 0) < 1000) return out;
    }
  }
  const csvOf = (cols: Col[], data: Row[]) => { const { headers, rows } = rowsOf(cols, data); return toCsv(headers, rows as Cell[][]); };
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg(`失敗しました: ${e instanceof Error ? e.message : String(e)}`); }
    setBusy(false);
  };

  const csvOnly = (view: string, cols: Col[], name: string) => run(async () => {
    const data = await fetchAll(view);
    save(csvOf(cols, data), `${name}_${stamp()}.csv`, "text/csv;charset=utf-8");
    setMsg(`${name}: ${data.length}件を出力しました`);
  });

  const zipAll = run(async () => {
    const [rec, iss, sent, issContent] = await Promise.all([fetchAll("v_export_received"), fetchAll("v_export_issued"), fetchAll("v_export_sent_files"), fetchAll("v_export_issued_content")]);
    const total = [...rec, ...sent].reduce((n, r) => n + Number(r.size_bytes ?? 0), 0);
    if (total > MAX_BYTES) throw new Error(`ファイルの合計が大きすぎます（${Math.round(total / 1048576)}MB）。期間を分けて出力してください`);
    const enc = new TextEncoder();
    const paths = uniquePaths([
      ...rec.map((r) => `受領書類/${r.doc_date}_${r.amount}_${safeName(String(r.counterparty_name), 40)}_${safeName(String(r.file_name))}`),
      ...sent.map((r) => `送付PDF/${r.doc_date}_${r.amount}_${safeName(String(r.counterparty_name), 40)}_${safeName(String(r.doc_no))}_${safeName(String(r.file_name))}`),
    ]);
    const entries: ZipEntry[] = [];
    const mismatches: string[] = [];
    const items = [...rec.map((r) => ({ r, rpc: "received_file_base64", arg: "p_id" })), ...sent.map((r) => ({ r, rpc: "document_file_base64", arg: "p_file_id" }))];
    for (let i = 0; i < items.length; i++) {
      const { r, rpc, arg } = items[i];
      setMsg(`ファイルを取得中… ${i + 1} / ${items.length}`);
      const { data, error } = await supabase.rpc(rpc, { [arg]: r.id as string });
      if (error || typeof data !== "string") throw new Error(`${r.file_name}: ${error?.message ?? "取得できません"}`);
      const bytes = b64ToBytes(data);
      if ((await sha256Hex(bytes)) !== r.sha256) mismatches.push(paths[i]);
      entries.push({ name: paths[i], data: bytes });
    }
    // 発行済み帳票: 固定した内容（JSON。ハッシュの計算に使った文字列そのもの）と、そこから作ったHTML
    const docPaths = uniquePaths(issContent.map((d) => `発行済み帳票/${d.doc_date}_${d.amount}_${safeName(String(d.counterparty_name), 40)}_${safeName(String(d.doc_no))}_v${d.version}`));
    const docMismatch: string[] = [];
    const { renderDocHtml } = await import("../lib/docHtml"); // 出力するときだけ読み込む
    for (let i = 0; i < issContent.length; i++) {
      const d = issContent[i];
      const text = String(d.content_text);
      if ((await sha256Hex(new Uint8Array(new TextEncoder().encode(text)))) !== d.content_sha256) docMismatch.push(docPaths[i]);
      const doc = { ...d, content: JSON.parse(text), source_id: "" } as unknown as IssuedDoc;
      entries.push({ name: `${docPaths[i]}.json`, data: enc.encode(text) }, { name: `${docPaths[i]}.html`, data: enc.encode(renderDocHtml(doc)) });
    }
    const readme = [
      "ダウンロードの求めへの出力（CROSSTECH 統合販売管理システム）",
      `出力日時: ${new Date().toLocaleString("ja-JP")}　出力者: ${who}`,
      `条件: 取引年月日 ${f.from || "指定なし"} 〜 ${f.to || "指定なし"}　取消済みを${f.voided ? "含む" : "含まない"}`,
      `件数: 受領書類 ${rec.length}件、発行済み帳票 ${iss.length}件（版ごと）、送付PDF ${sent.length}件`,
      "",
      "【内容】",
      "受領書類一覧.csv / 発行済み帳票一覧.csv / 送付PDF一覧.csv … 検索項目（取引年月日・取引金額・取引先）、ハッシュ、タイムスタンプの状況などの一覧（UTF-8、Excelで開けます）",
      "受領書類/ … 受領した書類のファイル本体。ファイル名は「取引年月日_取引金額_取引先_元のファイル名」",
      "送付PDF/ … 取引先へ送付したPDF。ファイル名は「取引年月日_取引金額_取引先_帳票番号_元のファイル名」",
      "発行済み帳票/ … 発行した見積書・納品書・請求書。.html はブラウザで開けます（印刷・PDF保存も可）。.json は発行時に固定した内容そのもので、そのSHA-256が「発行済み帳票一覧.csv」の「内容のSHA-256」です。ファイル名は「取引年月日_取引金額_取引先_帳票番号_v版」",
      "",
      "【整合性の確認】",
      mismatches.length === 0 ? "受領書類・送付PDFのすべてのファイルのSHA-256が、登録時に記録した値と一致しました。" : `次のファイルは、登録時のSHA-256と一致しませんでした:\n${mismatches.join("\n")}`,
      docMismatch.length === 0 ? "発行済み帳票の固定内容（.json）のSHA-256が、発行時に記録した値と一致しました。" : `次の帳票の固定内容は、発行時のSHA-256と一致しませんでした:\n${docMismatch.join("\n")}`,
      "タイムスタンプの署名の検証は、scripts/verify_timestamp.sh（OpenSSL）で行えます。",
    ].join("\r\n");
    entries.unshift(
      { name: "受領書類一覧.csv", data: enc.encode(csvOf(RECEIVED_COLS, rec)) },
      { name: "発行済み帳票一覧.csv", data: enc.encode(csvOf(ISSUED_COLS, iss)) },
      { name: "送付PDF一覧.csv", data: enc.encode(csvOf(SENT_COLS, sent)) },
      { name: "README.txt", data: enc.encode(readme) },
    );
    save(makeZip(entries), `ダウンロード一式_${stamp()}.zip`, "application/zip");
    setMsg(`出力しました（受領書類 ${rec.length}件、帳票 ${iss.length}件、送付PDF ${sent.length}件）${mismatches.length + docMismatch.length ? `。SHA-256が一致しないものが${mismatches.length + docMismatch.length}件あります` : ""}`);
  });

  return (
    <div className="card stack">
      <h3>税務調査の「ダウンロードの求め」への出力</h3>
      <p className="inactive">一覧（検索項目つき）はCSV、ファイル本体はZIPで出力します。出力する期間（取引年月日）を指定してください。</p>
      <div className="grid">
        <label>取引年月日（から）<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>取引年月日（まで）<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.voided} onChange={(e) => setF({ ...f, voided: e.target.checked })} /> 取消済みも含める（既定。取消の有無・理由が列に出ます）</label>
      </div>
      <div className="row">
        <button disabled={busy} onClick={csvOnly("v_export_received", RECEIVED_COLS, "受領書類一覧")}>受領書類CSV</button>
        <button disabled={busy} onClick={csvOnly("v_export_issued", ISSUED_COLS, "発行済み帳票一覧")}>発行済み帳票CSV</button>
        <button disabled={busy} onClick={csvOnly("v_export_sent_files", SENT_COLS, "送付PDF一覧")}>送付PDFのCSV</button>
        <button disabled={busy} onClick={zipAll}>一式（CSV＋ファイル本体）をZIPで出力</button>
      </div>
      {msg && <p>{msg}</p>}
      <p className="inactive">ZIPには、3つのCSV、受領書類・送付PDFのファイル本体、発行済み帳票（固定内容のJSONと、ブラウザで開けるHTML）、README（条件・件数・SHA-256の照合結果）が入ります。ファイルの合計が300MBを超える場合は、期間を分けてください。</p>
    </div>
  );
}
