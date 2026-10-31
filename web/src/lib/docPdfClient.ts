import type { IssuedDoc } from "./documents";
import { saveBlob } from "./download";

let fontCache: Promise<Uint8Array> | null = null;
const loadFont = () => (fontCache ??= fetch(`${import.meta.env.BASE_URL}fonts/CrosstechSansJP-Regular.ttf`).then(async (r) => {
  if (!r.ok) throw new Error("PDF用のフォントを読み込めません");
  return new Uint8Array(await r.arrayBuffer());
}));

/** 固定した帳票の内容から、送付用のPDFを作る（PDFのライブラリとフォントは、使うときだけ読み込む）。 */
export async function generatePdf(doc: IssuedDoc) {
  const [{ makeDocPdf, pdfFileName }, font] = await Promise.all([import("./docPdf"), loadFont()]);
  const r = await makeDocPdf(doc.content, { version: doc.version, issued_at: doc.issued_at, content_sha256: doc.content_sha256, voided: doc.voided, void_reason: doc.void_reason }, font);
  return { bytes: r.bytes, missing: r.missing, fileName: pdfFileName(doc.content, doc.version, doc.amount) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function downloadBytes(bytes: Uint8Array, name: string, type = "application/pdf") {
  saveBlob(bytes as unknown as BlobPart, name, type);
}
