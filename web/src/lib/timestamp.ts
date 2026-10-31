import { supabase } from "./supabase";

export type SubjectTable = "received_documents" | "document_files" | "issued_documents";

/** タイムスタンプの付与を依頼する（Edge Function timestamp）。失敗しても対象の登録は有効で、付与待ちとして一覧に残る。 */
export async function requestTimestamp(table: SubjectTable, id: string): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase.functions.invoke("timestamp", { body: { subject_table: table, subject_id: id } });
  if (!error) return { ok: true, message: `付与しました（${new Date((data as { gen_time: string }).gen_time).toLocaleString("ja-JP")}）` };
  const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
  return { ok: false, message: [detail?.error ?? error.message, detail?.detail].filter(Boolean).join(" / ") };
}

export const TS_STATUS: Record<string, string> = {
  stamped: "付与済み", stamped_late: "付与済み（期限後）", pending: "付与待ち", overdue: "期限超過（未付与）",
};
