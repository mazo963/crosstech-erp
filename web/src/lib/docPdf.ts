// 固定した帳票の内容から、A4のPDF（テキスト・日本語フォント埋め込み）を作る。
// 同じ内容・同じフォント・同じひな形なら、毎回まったく同じバイト列になる（日時は発行日時、乱数は固定）。
//   → 送ったPDFを後から再現でき、ハッシュも安定する。ひな形を変えたら PDF_TEMPLATE_VERSION を上げる。
import { PDFDocument, PDFFont, PDFPage, degrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { DocContent } from "./documents.ts";
import { DOC_LABEL } from "./documents.ts";
import { jst } from "./format.ts";
export { jst };

export const PDF_TEMPLATE_VERSION = 1;

export type PdfMeta = { version: number; issued_at: string; content_sha256: string; voided: boolean; void_reason: string | null };
export type PdfResult = { bytes: Uint8Array; missing: string[] };

const mm = (v: number) => (v * 72) / 25.4;
const W = 595.28, H = 841.89;
const ML = mm(18), MR = W - mm(18), MT = mm(16), MB = mm(16);
const GRAY = rgb(0.42, 0.45, 0.5), BLACK = rgb(0.07, 0.07, 0.07);

const fmt = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const [i, d] = String(n).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
};
const yen = (v: unknown) => (v == null ? "-" : `¥${fmt(v)}`);
const pct = (r: unknown) => `${Math.round(Number(r) * 10000) / 100}%`;

export async function makeDocPdf(c: DocContent, meta: PdfMeta, fontBytes: Uint8Array): Promise<PdfResult> {
  // フォントの部分埋め込みが、名前に乱数を使うので、固定の疑似乱数に差し替える（終わったら戻す）
  const realRandom = Math.random;
  let seed = 123456789;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  try {
    return await build(c, meta, fontBytes);
  } finally {
    Math.random = realRandom;
  }
}

async function build(c: DocContent, meta: PdfMeta, fontBytes: Uint8Array): Promise<PdfResult> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const fk = fontkit.create(fontBytes as never) as unknown as { hasGlyphForCodePoint(cp: number): boolean };
  const missing = new Set<string>();
  const safe = (s: string) => Array.from(s).map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || fk.hasGlyphForCodePoint(cp)) return ch;
    missing.add(ch);
    return "?";
  }).join("");

  const label = DOC_LABEL[c.doc_type];
  const isInvoice = c.doc_type === "invoice";
  const copy = isInvoice && !c.official;
  const hasRate = c.lines.some((l) => l.tax_rate != null) && c.doc_type !== "delivery_note";
  const hasReduced = c.lines.some((l) => l.is_reduced);

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => { page = pdf.addPage([W, H]); pages.push(page); y = MT; };
  const wid = (s: string, size: number) => font.widthOfTextAtSize(s, size);
  const draw = (s: string, x: number, size: number, o: { align?: "l" | "r" | "c"; color?: ReturnType<typeof rgb>; bold?: boolean; yy?: number } = {}) => {
    const t = safe(s);
    const w = wid(t, size);
    const px = o.align === "r" ? x - w : o.align === "c" ? x - w / 2 : x;
    const py = H - (o.yy ?? y) - size;
    page.drawText(t, { x: px, y: py, size, font, color: o.color ?? BLACK });
    if (o.bold) page.drawText(t, { x: px + 0.35, y: py, size, font, color: o.color ?? BLACK }); // 擬似的な太字
    return w;
  };
  const wrap = (s: string, size: number, max: number): string[] => {
    const out: string[] = [];
    for (const para of safe(s).split("\n")) {
      let line = "";
      for (const ch of Array.from(para)) {
        if (line && wid(line + ch, size) > max) { out.push(line); line = ch; } else line += ch;
      }
      out.push(line);
    }
    return out;
  };
  const rule = (yy: number, x1 = ML, x2 = MR, th = 0.5, color = rgb(0.88, 0.9, 0.92)) =>
    page.drawLine({ start: { x: x1, y: H - yy }, end: { x: x2, y: H - yy }, thickness: th, color });
  const ensure = (need: number) => { if (y + need > H - MB) { newPage(); header(); } };

  // 表の列（各列の右端の位置。残りが品名の幅）
  const cols = hasRate
    ? { rate: MR, amount: MR - 48, price: MR - 48 - 70, qty: MR - 48 - 70 - 70 }
    : { amount: MR, price: MR - 70, qty: MR - 70 - 70 };
  const nameMax = cols.qty - 56 - ML - 8;
  const tableHead = () => {
    page.drawRectangle({ x: ML, y: H - y - 18, width: MR - ML, height: 18, color: rgb(0.95, 0.95, 0.96) });
    y += 4;
    draw(isInvoice ? "内容" : "製番 / 品名", ML + 6, 9, { bold: true });
    draw("数量", cols.qty, 9, { align: "r", bold: true });
    draw("単価", cols.price, 9, { align: "r", bold: true });
    draw("金額", cols.amount, 9, { align: "r", bold: true });
    if (hasRate) draw("税率", (cols as { rate: number }).rate, 9, { align: "r", bold: true });
    y += 14;
  };
  let header = () => {};

  newPage();
  if (copy) {
    page.drawRectangle({ x: ML, y: H - y - 20, width: MR - ML, height: 20, color: rgb(0.996, 0.953, 0.78), borderColor: rgb(0.96, 0.62, 0.04), borderWidth: 0.6 });
    draw(`【ERP控え・社内用】正式な請求書はマネーフォワードで発行${c.mf_invoice_no ? `（MF請求書番号: ${c.mf_invoice_no}）` : ""}`, (ML + MR) / 2, 9, { align: "c", yy: y + 5 });
    y += 30;
  }
  const title = `${label}${copy ? "（控え）" : ""}`;
  { // 見出し（字間を空ける）
    const size = 20, gap = size * 0.4;
    const chars = Array.from(safe(title));
    const total = chars.reduce((n, ch) => n + wid(ch, size) + gap, -gap);
    let x = (ML + MR) / 2 - total / 2;
    for (const ch of chars) { draw(ch, x, size, { bold: true }); x += wid(ch, size) + gap; }
    y += 36;
  }
  // 宛先（左）と発行者（右）
  const top = y;
  const nameW = draw(`${c.customer.name} 御中`, ML, 13);
  rule(top + 18, ML, ML + nameW, 0.8, BLACK);
  let ly = top + 24;
  const left = (s: string) => { for (const l of wrap(s, 9, (MR - ML) / 2 - 10)) { draw(l, ML, 9, { yy: ly }); ly += 13; } };
  if (c.customer.address) left(`${c.customer.postal_code ? `〒${c.customer.postal_code} ` : ""}${c.customer.address}`);
  if (c.title) left(`件名: ${c.title}`);
  if (c.customer_po_no) left(`客先注文番号: ${c.customer_po_no}`);
  if (c.period_to) left(`対象期間: ${c.period_from ?? "初回"} 〜 ${c.period_to}`);
  let ry = top;
  const right = (s: string, bold = false, size = 9) => { draw(s, MR, size, { align: "r", yy: ry, bold }); ry += size + 4; };
  right(`${label}番号 ${c.doc_no}`);
  right(`${isInvoice ? "請求日" : c.doc_type === "quote" ? "見積日" : "納品日"} ${c.doc_date}`);
  right(c.issuer.company_name, true, 10);
  if (c.issuer.address) right(`${c.issuer.postal_code ? `〒${c.issuer.postal_code} ` : ""}${c.issuer.address}`);
  if (c.issuer.tel) right(`TEL ${c.issuer.tel}`);
  if (c.issuer.invoice_reg_no) right(`登録番号 ${c.issuer.invoice_reg_no}`);
  y = Math.max(ly, ry) + 14;

  if (isInvoice) { draw(`ご請求金額 ${yen(c.total)}（税込）${c.due_date ? `　お支払期日 ${c.due_date}` : ""}`, ML, 12.5, { bold: true }); y += 26; }
  else if (c.doc_type === "quote") { draw(`お見積金額 ${yen(c.total)}（税込）${c.due_date ? `　納期 ${c.due_date}` : ""}`, ML, 12.5, { bold: true }); y += 26; }

  header = tableHead;
  tableHead();
  for (const l of c.lines) {
    const first = `${l.is_reduced ? "※ " : ""}${isInvoice ? l.description ?? "" : `${l.product_no ?? ""} ${l.name ?? ""}`.trim()}`;
    const lines = wrap(first, 9, nameMax);
    const spec = l.spec ? wrap(l.spec, 8, nameMax) : [];
    ensure(lines.length * 12 + spec.length * 11 + 10);
    let yy = y + 3;
    for (const t of lines) { draw(t, ML + 6, 9, { yy }); yy += 12; }
    for (const t of spec) { draw(t, ML + 6, 8, { yy, color: GRAY }); yy += 11; }
    draw(`${fmt(l.quantity)}${l.unit ?? ""}`, cols.qty, 9, { align: "r", yy: y + 3 });
    draw(yen(l.unit_price), cols.price, 9, { align: "r", yy: y + 3 });
    draw(yen(l.amount), cols.amount, 9, { align: "r", yy: y + 3 });
    if (hasRate) draw(l.tax_rate != null ? pct(l.tax_rate) : "", (cols as { rate: number }).rate, 9, { align: "r", yy: y + 3 });
    y = Math.max(yy, y + 15) + 3;
    rule(y);
  }
  y += 8;
  ensure(90);
  const total = (s: string, bold = false) => { draw(s, MR, 9.5, { align: "r", bold }); y += 14; };
  total(`小計（税抜） ${yen(c.subtotal)}`);
  for (const t of c.tax_breakdown ?? []) total(`${pct(t.rate)}対象${t.reduced ? "（※軽減税率）" : ""} ${yen(t.base)}　消費税 ${yen(t.tax)}`);
  if (c.total != null) total(`合計 ${yen(c.total)}`, true);
  if (hasReduced) { y += 2; draw("※は軽減税率の対象品目です。", ML, 8, { color: GRAY }); y += 12; }
  if (isInvoice && c.bank_info) { for (const t of wrap(`お振込先: ${c.bank_info}`, 9, MR - ML)) { ensure(14); draw(t, ML, 9); y += 13; } }
  if (c.notes) { for (const t of wrap(`備考: ${c.notes}`, 8.5, MR - ML)) { ensure(13); draw(t, ML, 8.5, { color: GRAY }); y += 12; } }
  ensure(16);
  draw(`発行 ${jst(meta.issued_at)}　版 ${meta.version}　内容ハッシュ ${meta.content_sha256.slice(0, 12)}`, ML, 8, { color: GRAY });

  pages.forEach((p, i) => {
    page = p;
    if (pages.length > 1) draw(`${i + 1} / ${pages.length}`, W / 2, 8, { align: "c", color: GRAY, yy: H - mm(10) - 8 });
    if (meta.voided) {
      p.drawText(safe("取消済み"), { x: W * 0.22, y: H * 0.45, size: 44, font, color: rgb(0.72, 0.11, 0.11), rotate: degrees(18), opacity: 0.5 });
    }
  });

  const issued = new Date(meta.issued_at);
  pdf.setTitle(`${label} ${c.doc_no}（版${meta.version}）`);
  pdf.setAuthor(c.issuer.company_name);
  pdf.setSubject(`${c.customer.name} ${c.doc_date}`);
  pdf.setKeywords([`sha256:${meta.content_sha256}`, `template:${PDF_TEMPLATE_VERSION}`]);
  pdf.setCreator("crosstech-erp");
  pdf.setProducer("crosstech-erp (pdf-lib)");
  pdf.setCreationDate(issued);
  pdf.setModificationDate(issued);
  return { bytes: await pdf.save({ useObjectStreams: false }), missing: [...missing] };
}

/** ファイル名: 取引年月日_取引金額_取引先_帳票番号_v版.pdf（日付・金額・取引先の順。Boxや検索で探しやすい）。 */
export function pdfFileName(c: DocContent, version: number, amount: number): string {
  const clean = (s: string) => Array.from(s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim()).slice(0, 40).join("") || "_";
  return `${c.doc_date}_${amount}_${clean(c.customer.name)}_${clean(c.doc_no)}_v${version}.pdf`;
}
