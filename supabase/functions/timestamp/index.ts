// Edge Function: timestamp
// 受領書類・送付したPDF・発行帳票のハッシュに、時刻認証局（TSA, RFC 3161）のタイムスタンプを付与して記録する。
// TSA の URL・認証情報は secret（TSA_URL / TSA_NAME / TSA_AUTH）。応答やログに出さない。
// 法令上は、認定された時刻認証事業者のものを使う必要がある（docs/電帳法対応方針.md）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildTimeStampReq, parseTimeStampResp } from "./rfc3161.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const TABLES = ["received_documents", "document_files", "issued_documents"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST のみ対応" });
  const auth = req.headers.get("Authorization");
  if (!auth) return json(401, { error: "ログインが必要です" });

  const tsaUrl = Deno.env.get("TSA_URL");
  const tsaName = Deno.env.get("TSA_NAME");
  if (!tsaUrl || !tsaName) return json(503, { error: "タイムスタンプ局が未設定です（TSA_URL / TSA_NAME）。付与は保留されます" });

  let body: { subject_table?: string; subject_id?: string };
  try { body = await req.json(); } catch { return json(400, { error: "JSONが不正です" }); }
  if (!body.subject_table || !TABLES.includes(body.subject_table) || !body.subject_id) return json(400, { error: "付与対象が不正です" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const subject = await db.rpc("timestamp_subject", { p_table: body.subject_table, p_id: body.subject_id });
  if (subject.error) return json(404, { error: subject.error.message });
  const sha256 = (Array.isArray(subject.data) ? subject.data[0] : subject.data)?.o_sha256 as string | undefined;
  if (!sha256) return json(404, { error: "付与対象のハッシュを取得できません" });

  const nonce = crypto.getRandomValues(new Uint8Array(8));
  let result;
  try {
    const headers: Record<string, string> = { "content-type": "application/timestamp-query" };
    const tsaAuth = Deno.env.get("TSA_AUTH");
    if (tsaAuth) headers["authorization"] = tsaAuth;
    const res = await fetch(tsaUrl, { method: "POST", headers, body: buildTimeStampReq(sha256, nonce), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return json(502, { error: `タイムスタンプ局の応答が異常です（HTTP ${res.status}）` });
    result = parseTimeStampResp(new Uint8Array(await res.arrayBuffer()), sha256, nonce);
  } catch (e) {
    // URL・認証情報が含まれうるので、エラーの本文は返さない（種類と、検証エラーの日本語メッセージのみ）
    const msg = e instanceof Error && /[ぁ-んァ-ン一-龥]/.test(e.message) ? e.message : undefined;
    return json(502, { error: "タイムスタンプの取得に失敗しました", detail: msg, kind: e instanceof Error ? e.name : "Error" });
  }

  let binary = "";
  result.token.forEach((b) => { binary += String.fromCharCode(b); });
  const rec = await db.rpc("record_timestamp", {
    p_table: body.subject_table, p_id: body.subject_id, p_tsa_name: tsaName,
    p_gen_time: result.genTime.toISOString(), p_serial: result.serialHex, p_token_b64: btoa(binary),
  });
  if (rec.error) return json(500, { error: `記録に失敗しました: ${rec.error.message}` });
  return json(200, { id: rec.data, gen_time: result.genTime.toISOString(), tsa_name: tsaName });
});
