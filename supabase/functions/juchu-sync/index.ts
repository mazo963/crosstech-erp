// Edge Function: juchu-sync
// 受注GAS（doGet）から進捗を読み取り、project_items.juchu_* を更新する。受注側へは書き込まない。
// GAS の URL は secret JUCHU_GAS_URL（コード・ログ・応答に出さない）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { extractRecords, planUpdates } from "./logic.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST のみ対応" });
  const auth = req.headers.get("Authorization");
  if (!auth) return json(401, { error: "ログインが必要です" });
  const gasUrl = Deno.env.get("JUCHU_GAS_URL");
  if (!gasUrl) return json(500, { error: "サーバー設定が未完了です（JUCHU_GAS_URL）" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });

  // 同期は admin / office のみ（RLSの更新権限と同じ）。先にERP側の品目を読む
  const { data: items, error: readErr } = await db
    .from("project_items")
    .select("id, product_no, juchu_completed_at, juchu_shipped_date")
    .not("product_no", "is", null);
  if (readErr) return json(403, { error: `品目を読めません: ${readErr.message}` });

  let records;
  try {
    const res = await fetch(gasUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return json(502, { error: `受注システムの応答が異常です（HTTP ${res.status}）` });
    records = extractRecords(await res.json());
  } catch (e) {
    // URL（秘密）が含まれうるのでエラー本文は返さない
    const kind = e instanceof Error ? e.name : "Error";
    return json(502, { error: "受注システムからの取得に失敗しました", kind });
  }

  const plan = planUpdates(records, items ?? []);
  const now = new Date().toISOString();
  let failed = 0;
  for (const u of plan.updates) {
    const { error } = await db.from("project_items")
      .update({ juchu_completed_at: u.juchu_completed_at, juchu_shipped_date: u.juchu_shipped_date, juchu_synced_at: now })
      .eq("id", u.id);
    if (error) failed++;
  }
  // 変化が無かった一致品目も「同期した時刻」だけ更新する
  const changed = new Set(plan.updates.map((u) => u.id));
  const rest = plan.matchedIds.filter((id) => !changed.has(id));
  if (rest.length) {
    const { error } = await db.from("project_items").update({ juchu_synced_at: now }).in("id", rest);
    if (error) failed += rest.length;
  }
  if (failed > 0 && failed === plan.matchedIds.length) {
    return json(403, { error: "更新できませんでした（admin / office 権限が必要です）" });
  }
  return json(200, {
    synced_at: now,
    matched: plan.matchedIds.length,
    updated: plan.updates.length - Math.min(failed, plan.updates.length),
    failed,
    not_in_erp: plan.notInErp,
    not_in_juchu: plan.notInJuchu,
  });
});
