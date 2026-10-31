import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { DocContent, DocType, IssuedDoc } from "../lib/documents";
import { DocumentView } from "./DocumentView";
import { FitPage } from "./FitPage";

/** 帳票の発行イメージ。発行せずに、いま発行したらこうなる内容をDBから取り（保存しない）、A4の見た目で出す。 */
export function DocPreview({ type, sourceId, rev }: { type: DocType; sourceId: string; rev?: number }) {
  const [doc, setDoc] = useState<IssuedDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    supabase.rpc("preview_document", { p_type: type, p_source_id: sourceId }).then(({ data, error }) => {
      if (!alive) return;
      if (error) { setDoc(null); return setError(error.message); }
      const c = data as DocContent;
      setDoc({
        id: "preview", doc_type: type, source_id: sourceId, doc_no: c.doc_no, version: 0, doc_date: c.doc_date, amount: 0,
        counterparty_name: c.customer.name, content: c, content_sha256: "", voided: false, void_reason: null, issued_at: new Date().toISOString(),
      });
    });
    return () => { alive = false; };
  }, [type, sourceId, rev]);

  if (error) return <p className="error">発行イメージを作れません: {error}</p>;
  if (!doc) return <p className="inactive">発行イメージを読み込み中…</p>;
  return <FitPage><DocumentView doc={doc} preview /></FitPage>;
}
