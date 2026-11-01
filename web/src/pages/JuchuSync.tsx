import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { jst } from "../lib/format";
import { type SyncResult, summarize } from "../lib/juchu";

const SHOW = 20;

/** 受注システム（加工現場）から、加工完了・出荷の進捗を読み取って反映する。受注側は変更しない。 */
export function JuchuSync({ canWrite, onDone }: { canWrite: boolean; onDone?: () => void }) {
  const [last, setLast] = useState<string | null>(null);
  const [res, setRes] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLast = useCallback(() => {
    supabase.from("project_items").select("juchu_synced_at").not("juchu_synced_at", "is", null)
      .order("juchu_synced_at", { ascending: false }).limit(1)
      .then(({ data }) => setLast((data as { juchu_synced_at: string }[] | null)?.[0]?.juchu_synced_at ?? null));
  }, []);
  useEffect(() => { loadLast(); }, [loadLast]);

  async function run() {
    setBusy(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke("juchu-sync", { body: {} });
      if (error) {
        const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
        throw new Error(detail?.error ?? error.message);
      }
      setRes(data as SyncResult);
      loadLast(); onDone?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }

  const list = (title: string, hint: string, v: string[]) => v.length > 0 && (
    <details><summary>{title}（{v.length}件）</summary>
      <p className="inactive">{hint}</p>
      <p>{v.slice(0, SHOW).join("、")}{v.length > SHOW ? ` ほか${v.length - SHOW}件` : ""}</p>
    </details>
  );
  return (
    <div className="card stack no-print">
      <div className="row">
        <h3>受注システムとの同期</h3>
        {canWrite && <button onClick={run} disabled={busy}>{busy ? "同期中…" : "受注システムと同期"}</button>}
      </div>
      <p className="inactive">加工完了・出荷の進捗を、製番で読み取ります（受注側は変更しません）。最終同期: {last ? jst(last) : "まだありません"}</p>
      {error && <p className="error">{error}</p>}
      {res && (
        <div className="stack">
          <p>{summarize(res)}</p>
          {list("受注側にだけある製番", "ERPに登録がありません。ERPで案件・製番を登録してください（製番は ERP が親です）。", res.not_in_erp)}
          {list("ERPにだけある製番", "受注側にまだ登録がないか、製番が違っている可能性があります。", res.not_in_juchu)}
        </div>
      )}
    </div>
  );
}
