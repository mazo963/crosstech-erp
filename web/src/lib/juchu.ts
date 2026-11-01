// 受注システム（加工現場）との同期。ERPは読み取るだけで、受注側へは書き込まない（Edge Function juchu-sync）。
export type SyncResult = {
  synced_at: string; matched: number; updated: number; failed: number;
  not_in_erp: string[]; not_in_juchu: string[];
};

/** 加工状況の表示。受注側に完了日時が無いまま「完了」のとき、サーバーは 1970 年で保存する。 */
export function juchuState(completedAt: string | null, shippedDate: string | null, syncedAt: string | null): { label: string; tone: "none" | "wip" | "done" | "shipped" } {
  if (!syncedAt) return { label: "未同期", tone: "none" };
  if (shippedDate) return { label: `出荷済 ${shippedDate}`, tone: "shipped" };
  if (completedAt) {
    const t = new Date(completedAt);
    return { label: t.getUTCFullYear() <= 1970 ? "加工完了" : `加工完了 ${new Date(t.getTime() + 9 * 3600_000).toISOString().slice(0, 10)}`, tone: "done" };
  }
  return { label: "加工中・未完了", tone: "wip" };
}

/** 同期結果の1行の説明。 */
export function summarize(r: SyncResult): string {
  const parts = [`受注側と一致 ${r.matched}件`, `更新 ${r.updated}件`];
  if (r.failed) parts.push(`更新できず ${r.failed}件`);
  if (r.not_in_erp.length) parts.push(`受注側にだけある製番 ${r.not_in_erp.length}件`);
  if (r.not_in_juchu.length) parts.push(`ERPにだけある製番 ${r.not_in_juchu.length}件`);
  return parts.join(" ／ ");
}
