// 表示用の整形だけ。金額の計算はDB側で行う（CLAUDE.md §3-1）。
export const yen = (v: number | string | null | undefined) =>
  v == null ? "-" : `¥${Number(v).toLocaleString("ja-JP")}`;

export const pct = (v: number | string | null | undefined) => (v == null ? "-" : `${Number(v)}%`);

/** 日時（UTCのISO文字列）を日本時間の「YYYY-MM-DD HH:mm」で表示する。 */
export const jst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
