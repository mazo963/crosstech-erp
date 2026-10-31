import { useState } from "react";
import { supabase } from "../lib/supabase";
import { type DocType, DOC_LABEL, openDocument } from "../lib/documents";

/** 帳票を発行（内容を固定）して開く。同じ内容なら既存の版を開き、変わっていれば新しい版を作る。 */
export function IssueButton({ type, sourceId, label }: { type: DocType; sourceId: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function issue() {
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc("issue_document", { p_type: type, p_source_id: sourceId });
    setBusy(false);
    if (error) return setError(error.message);
    openDocument(data as string);
  }
  return (
    <>
      <button type="button" className="secondary" disabled={busy} onClick={issue}>{busy ? "発行中…" : label ?? `${DOC_LABEL[type]}を発行・表示`}</button>
      {error && <span className="error">{error}</span>}
    </>
  );
}
