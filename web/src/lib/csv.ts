// CSVの組み立て。Excelで開けるよう、UTF-8（BOM付き）・CRLF・必要なセルだけ引用符で囲む。
export type Cell = string | number | boolean | null | undefined;

const cell = (v: Cell): string => {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "はい" : "いいえ";
  let s = String(v);
  // 表計算ソフトで「式」として実行されるのを防ぐ（先頭が = + - @ やタブ・改行の文字列）。数値は対象外
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(headers: string[], rows: Cell[][]): string {
  return "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
