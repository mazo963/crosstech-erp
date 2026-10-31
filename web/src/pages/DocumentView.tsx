import type { IssuedDoc } from "../lib/documents";
import { DOC_LABEL } from "../lib/documents";
import { yen } from "../lib/format";

/** 発行時に固定した内容から帳票を描く（元データではなく固定内容を使うので、再印刷しても同じになる）。 */
export function DocumentView({ doc }: { doc: IssuedDoc }) {
  const c = doc.content;
  const isInvoice = c.doc_type === "invoice";
  const copy = isInvoice && !c.official; // MFが正式な請求書のとき、ERPの請求書は控え・社内用
  return (
    <div className="paper">
      {doc.voided && <div className="stamp">取消済み{doc.void_reason ? `（${doc.void_reason}）` : ""}</div>}
      {copy && <p className="copy-note">【ERP控え・社内用】正式な請求書はマネーフォワードで発行{c.mf_invoice_no ? `（MF請求書番号: ${c.mf_invoice_no}）` : ""}</p>}
      <h1>{DOC_LABEL[c.doc_type]}{copy ? "（控え）" : ""}</h1>
      <div className="paper-head">
        <div>
          <p className="to">{c.customer.name} 御中</p>
          {c.customer.address && <p>{c.customer.postal_code && `〒${c.customer.postal_code} `}{c.customer.address}</p>}
          {c.title && <p>件名: {c.title}</p>}
          {c.customer_po_no && <p>客先注文番号: {c.customer_po_no}</p>}
          {c.period_to && <p>対象期間: {c.period_from ?? "初回"} 〜 {c.period_to}</p>}
        </div>
        <div className="issuer">
          <p>{DOC_LABEL[c.doc_type]}番号 {c.doc_no}</p>
          <p>{isInvoice ? "請求日" : c.doc_type === "quote" ? "見積日" : "納品日"} {c.doc_date}</p>
          <p><strong>{c.issuer.company_name}</strong></p>
          {c.issuer.address && <p>{c.issuer.postal_code && `〒${c.issuer.postal_code} `}{c.issuer.address}</p>}
          {c.issuer.tel && <p>TEL {c.issuer.tel}</p>}
          {c.issuer.invoice_reg_no && <p>登録番号 {c.issuer.invoice_reg_no}</p>}
        </div>
      </div>
      {isInvoice && <p className="big">ご請求金額 {yen(c.total)}（税込）{c.due_date && <>　お支払期日 {c.due_date}</>}</p>}
      {c.doc_type === "quote" && <p className="big">お見積金額 {yen(c.total)}（税込）{c.due_date && <>　納期 {c.due_date}</>}</p>}
      <table>
        <thead><tr><th>{isInvoice ? "内容" : "製番 / 品名"}</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
        <tbody>
          {c.lines.map((l, i) => (
            <tr key={i}>
              <td>{isInvoice ? l.description : `${l.product_no ?? ""} ${l.name ?? ""}`}{l.spec && <div className="spec">{l.spec}</div>}</td>
              <td>{l.quantity}{l.unit ?? ""}</td><td>{yen(l.unit_price)}</td><td>{yen(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="totals">
        <p>小計（税抜） {yen(c.subtotal)}</p>
        {c.tax_breakdown?.map((t) => <p key={t.rate}>{Number(t.rate) * 100}%対象 {yen(t.base)}　消費税 {yen(t.tax)}</p>)}
        {c.doc_type === "quote" && <p>消費税（{Number(c.tax_rate) * 100}%） {yen(c.tax)}</p>}
        {c.total != null && <p><strong>合計 {yen(c.total)}</strong></p>}
      </div>
      {isInvoice && c.bank_info && <p className="bank">お振込先: {c.bank_info}</p>}
      {c.notes && <p className="notes">備考: {c.notes}</p>}
      <p className="foot">発行 {doc.issued_at.slice(0, 16).replace("T", " ")}　版 {doc.version}　内容ハッシュ {doc.content_sha256.slice(0, 12)}</p>
    </div>
  );
}
