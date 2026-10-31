import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { IssuedDoc } from "../lib/documents";
import { type CustomerMail, boxMail, customerAddrs, customerMail, mailto } from "../lib/mail";
import { downloadBytes, generatePdf } from "../lib/docPdfClient";
import { useSettings } from "../lib/useSettings";

/** 送付の手順: ① PDFをダウンロード → ② お客様宛メール → ③ Box宛メール（別のメール）→ ④ 交付を記録（下）。 */
export function SendSteps({ doc }: { doc: IssuedDoc }) {
  const { settings } = useSettings();
  const [cust, setCust] = useState<CustomerMail | null>(null);
  const [name, setName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("customers").select("invoice_mail_to, invoice_mail_cc, delivery_mail_to, delivery_mail_cc").eq("id", doc.content.customer.id).single()
      .then(({ data }) => setCust((data as CustomerMail) ?? null));
    generatePdf(doc).then((r) => setName(r.fileName)).catch(() => undefined); // ファイル名だけ先に決める
  }, [doc]);

  async function download() {
    setBusy(true); setMsg(null);
    try {
      const r = await generatePdf(doc);
      downloadBytes(r.bytes, r.fileName);
      setMsg(r.missing.length ? `PDFを作りました。ただし、次の文字はフォントに無いため「?」で出力しました: ${r.missing.join(" ")}` : `PDFをダウンロードしました（${r.fileName}）`);
    } catch (e) { setMsg(`PDFを作れません: ${e instanceof Error ? e.message : String(e)}`); }
    setBusy(false);
  }

  if (doc.voided) return <div className="card inactive">この帳票は取消されているため、送付できません。</div>;
  const addrs = cust ? customerAddrs(doc.doc_type, cust) : { to: "", cc: "" };
  const fileName = name || "（PDF）";
  const cm = customerMail(doc.content, doc.amount, fileName, settings?.mail_signature ?? null);
  const bm = boxMail(doc.content, doc.amount, fileName);
  const box = settings?.box_import_email?.trim();
  return (
    <div className="card stack no-print">
      <h3>送付の手順</h3>
      <ol className="stepsl">
        <li>
          <strong>PDFをダウンロード</strong>　<button type="button" disabled={busy} onClick={download}>{busy ? "作成中…" : "PDFをダウンロード"}</button>
          <div className="inactive">固定した内容から作ります。同じ内容なら、いつ作っても同じPDFです。ファイル名: {fileName}</div>
        </li>
        <li>
          <strong>お客様宛にメール</strong>　
          {addrs.to ? <a className="btn" href={mailto(addrs.to, { cc: addrs.cc, ...cm })}>メールを作成（お客様宛）</a> : <span className="error">メールアドレスが未登録です（得意先マスタ）。紙の場合は、下で「紙」を記録してください</span>}
          <div className="inactive">{addrs.to && <>宛先: {addrs.to}{addrs.cc && `　CC: ${addrs.cc}`}　</>}①のPDFを添付して送信してください（ブラウザの仕様で、自動では添付できません）。</div>
        </li>
        <li>
          <strong>Box にも保存</strong>　
          {box ? <a className="btn" href={mailto(box, bm)}>メールを作成（Box宛）</a> : <span className="error">Box の取込アドレスが未設定です（設定）</span>}
          <div className="inactive">お客様宛とは<strong>別のメール</strong>で、<strong>同じPDF</strong>を添付して送信します。宛先は Box のアドレスだけにしてください（宛先が複数だと、Box に保存されません）。</div>
        </li>
        <li><strong>交付を記録</strong>（下の欄）。PDFで送ったときは、このシステムが作ったPDFを、そのまま保存します。</li>
      </ol>
      {msg && <p>{msg}</p>}
    </div>
  );
}
