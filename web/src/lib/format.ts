// 表示用の整形だけ。金額の計算はDB側で行う（CLAUDE.md §3-1）。
export const yen = (v: number | string | null | undefined) =>
  v == null ? "-" : `¥${Number(v).toLocaleString("ja-JP")}`;

export const pct = (v: number | string | null | undefined) => (v == null ? "-" : `${Number(v)}%`);
