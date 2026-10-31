import { useEffect, useState } from "react";
import { configured, supabase } from "./lib/supabase";
import { useSession } from "./lib/useSession";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Projects } from "./pages/Projects";
import { Invoices } from "./pages/Invoices";
import { Payments } from "./pages/Payments";
import { Documents } from "./pages/Documents";
import { docIdFromHash } from "./lib/documents";
import { TaxRates } from "./pages/TaxRates";
import { Received } from "./pages/Received";
import { Export } from "./pages/Export";
import { MasterPage } from "./pages/MasterPage";
import { customers, vendors } from "./lib/masters";

const tabs = ["ダッシュボード", "案件", "請求", "入金", "帳票", "受領書類", "出力", "税率", "得意先", "外注先"] as const;

export function App() {
  const { session, staff, loading } = useSession();
  const [tab, setTab] = useState<(typeof tabs)[number]>("ダッシュボード");
  const [docId, setDocId] = useState<string | null>(docIdFromHash());
  useEffect(() => {
    const onHash = () => { const id = docIdFromHash(); setDocId(id); if (id) setTab("帳票"); };
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!configured) {
    return <p className="error">web/.env に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください（.env.example 参照）。</p>;
  }
  if (loading) return <p>読み込み中…</p>;
  if (!session) return <Login />;
  if (!staff) {
    return (
      <div className="card login">
        <p>このアカウントはスタッフとして登録されていません。管理者に登録を依頼してください。</p>
        <button onClick={() => supabase.auth.signOut()}>ログアウト</button>
      </div>
    );
  }
  return (
    <>
      <header>
        <strong>CROSSTECH 販売管理</strong>
        <span>{staff.name}（{staff.role}）</span>
        <button onClick={() => supabase.auth.signOut()}>ログアウト</button>
      </header>
      <nav>
        {tabs.map((t) => <button key={t} className={t === tab ? "" : "secondary"} onClick={() => { setTab(t); if (t !== "帳票") window.location.hash = ""; }}>{t}</button>)}
      </nav>
      <main>
        {tab === "ダッシュボード" && <Dashboard />}
        {tab === "案件" && <Projects myId={staff.id} canWrite={staff.role !== "viewer"} />}
        {tab === "請求" && <Invoices canWrite={staff.role !== "viewer"} />}
        {tab === "入金" && <Payments canWrite={staff.role !== "viewer"} />}
        {tab === "帳票" && <Documents docId={docId} canWrite={staff.role !== "viewer"} />}
        {tab === "受領書類" && <Received canWrite={staff.role !== "viewer"} />}
        {tab === "出力" && <Export who={`${staff.name}（${staff.role}）`} />}
        {tab === "税率" && <TaxRates isAdmin={staff.role === "admin"} />}
        {tab === "得意先" && <MasterPage def={customers} canWrite={staff.role !== "viewer"} />}
        {tab === "外注先" && <MasterPage def={vendors} canWrite={staff.role !== "viewer"} />}
      </main>
    </>
  );
}
