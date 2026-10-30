// Edge Function: ai-extract
// メール本文 / 注文書PDF → 案件の下書きJSON。保存はしない（人が画面で確認してから保存）。
// ユーザーのJWTでDBに接続するので、RLS（スタッフのみ）がそのまま効く。
import { createClient } from "npm:@supabase/supabase-js@2";
import { callAnthropic, type Source } from "./anthropic.ts";
import { type Config, isOverLimit, matchCustomers, monthStartIso, normalizeDraft, pickModel, type SourceType } from "./logic.ts";

const MAX_TEXT = 20_000;
const MAX_PDF_BASE64 = 7_000_000; // 約5MB

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

  const cfg: Config = {
    modelDefault: Deno.env.get("AI_MODEL_DEFAULT") ?? "",
    modelAdvanced: Deno.env.get("AI_MODEL_ADVANCED") ?? "",
    monthlyLimit: Number(Deno.env.get("AI_MONTHLY_TOKEN_LIMIT") ?? "0"),
  };
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!cfg.modelDefault || !cfg.modelAdvanced || !apiKey) {
    return json(500, { error: "サーバー設定が未完了です（AI_MODEL_DEFAULT / AI_MODEL_ADVANCED / ANTHROPIC_API_KEY）" });
  }

  let payload: { source_type?: SourceType; text?: string; pdf_base64?: string; advanced?: boolean };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "JSONが不正です" });
  }
  const sourceType = payload.source_type;
  if (sourceType !== "email" && sourceType !== "po_pdf") return json(400, { error: "source_type は email か po_pdf" });

  let source: Source;
  if (sourceType === "email") {
    const text = (payload.text ?? "").trim();
    if (!text) return json(400, { error: "メール本文が空です" });
    if (text.length > MAX_TEXT) return json(400, { error: `本文が長すぎます（${MAX_TEXT}文字まで）` });
    source = { kind: "text", text };
  } else {
    const b64 = payload.pdf_base64 ?? "";
    if (!b64) return json(400, { error: "PDFがありません" });
    if (b64.length > MAX_PDF_BASE64) return json(400, { error: "PDFが大きすぎます（約5MBまで）" });
    source = { kind: "pdf", base64: b64 };
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const model = pickModel(cfg, sourceType, payload.advanced === true);

  // 月間トークン上限
  const { data: rows, error: usageErr } = await db
    .from("ai_extractions").select("input_tokens, output_tokens")
    .eq("status", "ok").gte("created_at", monthStartIso(new Date()));
  if (usageErr) return json(403, { error: `利用状況を確認できません: ${usageErr.message}` });
  const used = (rows ?? []).reduce((s, r) => s + r.input_tokens + r.output_tokens, 0);
  if (isOverLimit(used, cfg.monthlyLimit)) {
    await db.from("ai_extractions").insert({
      source_type: sourceType, model, status: "rejected",
      error_message: `月間上限超過（${used} / ${cfg.monthlyLimit}）`,
    });
    return json(429, { error: "今月のAI利用上限に達したため停止しています", used, limit: cfg.monthlyLimit });
  }

  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  try {
    const { input, usage } = await callAnthropic(apiKey, model, source, today);
    const draft = normalizeDraft(input);
    const { data: customers } = await db.from("customers").select("id, name, name_kana").eq("active", true);
    const candidates = matchCustomers(draft.customer_name, customers ?? []);
    const { data: log, error: logErr } = await db.from("ai_extractions").insert({
      source_type: sourceType, model, status: "ok", result: draft, ...usage,
    }).select("id").single();
    if (logErr) return json(500, { error: `取込ログの保存に失敗: ${logErr.message}` });
    return json(200, { extraction_id: log.id, model, usage, draft, customer_candidates: candidates });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("ai_extractions").insert({ source_type: sourceType, model, status: "error", error_message: message.slice(0, 500) });
    return json(502, { error: "AIによる抽出に失敗しました", detail: message });
  }
});
