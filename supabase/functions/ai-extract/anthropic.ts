// Anthropic Messages API 呼び出し（tool use で構造化出力）。fetch のみ使用。
import { SYSTEM_PROMPT, TOOL, TOOL_NAME } from "./schema.ts";

export type Usage = { input_tokens: number; output_tokens: number };

export type CallResult = { input: unknown; usage: Usage };

export type Source = { kind: "text"; text: string } | { kind: "pdf"; base64: string };

export async function callAnthropic(
  apiKey: string,
  model: string,
  source: Source,
  today: string,
  fetchFn: typeof fetch = fetch,
): Promise<CallResult> {
  const content = source.kind === "pdf"
    ? [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: source.base64 } },
      { type: "text", text: "この注文書から案件の下書きを抽出してください。" },
    ]
    : [{ type: "text", text: `<source>\n${source.text}\n</source>\n上記から案件の下書きを抽出してください。` }];

  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: `${SYSTEM_PROMPT}\ntoday: ${today}`,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const block = (body.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!block) throw new Error("AIが構造化結果を返しませんでした");
  return {
    input: block.input,
    usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
  };
}
