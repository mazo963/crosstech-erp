import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import css from "../style.css?raw";
import { DocumentView } from "../pages/DocumentView";
import { DOC_LABEL, type IssuedDoc } from "./documents";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 固定した内容から、単体で開けるHTML（画面・印刷と同じ見た目）を作る。ブラウザで開き、印刷・PDF保存ができる。 */
export function renderDocHtml(doc: IssuedDoc): string {
  const body = renderToStaticMarkup(createElement(DocumentView, { doc }));
  const title = `${DOC_LABEL[doc.doc_type]} ${doc.doc_no}（版${doc.version}）`;
  return [
    "<!doctype html>",
    '<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="content-sha256" content="${esc(doc.content_sha256)}">`,
    `<style>${css}\nbody{padding:16px}</style></head>`,
    `<body>${body}</body></html>`,
  ].join("\n");
}
