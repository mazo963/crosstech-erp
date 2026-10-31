import { useEffect, useState } from "react";
import { configured, supabase } from "./lib/supabase";
import { useSession } from "./lib/useSession";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Projects } from "./pages/Projects";
import { Invoices } from "./pages/Invoices";
import { Payments } from "./pages/Payments";
import { Documents } from "./pages/Documents";
import { parseRoute, clearRoute, type Route } from "./lib/nav";
import { Quotes } from "./pages/Quotes";
import { DeliveryList } from "./pages/DeliveryList";
import { TaxRates } from "./pages/TaxRates";
import { Received } from "./pages/Received";
import { Export } from "./pages/Export";
import { MasterPage } from "./pages/MasterPage";
import { customers, vendors } from "./lib/masters";

// 左のメニュー。業務の流れ（見積→案件→納品→請求→入金）の順
const groups = [
  ["", ["ダッシュボード"]],
  ["売上", ["見積", "案件", "納品", "請求", "入金"]],
  ["書類", ["帳票", "受領書類", "出力"]],
  ["マスタ", ["得意先", "外注先", "税率"]],
] as const;
type Tab = (typeof groups)[number][1][number];

export function App() {
  const { session, staff, loading } = useSession();
  const [tab, setTab] = useState<Tab>("ダッシュボード");
  const [route, setRoute] = useState<Route>(parseRoute());
  useEffect(() => {
    const onHash = () => { const r = parseRoute(); setRoute(r); if (r) setTab(r.kind === "doc" ? "帳票" : r.kind === "invoice" ? "請求" : "案件"); };
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
      <div className="shell">
      <nav className="side">
        {groups.map(([g, ts]) => (
          <div key={g || "top"}>
            {g && <h4>{g}</h4>}
            {ts.map((t) => <button key={t} className={t === tab ? "active" : ""} onClick={() => { setTab(t); clearRoute(); }}>{t}</button>)}
          </div>
        ))}
      </nav>
      <main>
        {tab === "ダッシュボード" && <Dashboard />}
        {tab === "見積" && <Quotes canWrite={staff.role !== "viewer"} />}
        {tab === "案件" && <Projects myId={staff.id} canWrite={staff.role !== "viewer"} routeId={route?.kind === "project" ? route.id : null} />}
        {tab === "納品" && <DeliveryList canWrite={staff.role !== "viewer"} />}
        {tab === "請求" && <Invoices canWrite={staff.role !== "viewer"} routeId={route?.kind === "invoice" ? route.id : null} />}
        {tab === "入金" && <Payments canWrite={staff.role !== "viewer"} />}
        {tab === "帳票" && <Documents docId={route?.kind === "doc" ? route.id : null} canWrite={staff.role !== "viewer"} />}
        {tab === "受領書類" && <Received canWrite={staff.role !== "viewer"} />}
        {tab === "出力" && <Export who={`${staff.name}（${staff.role}）`} />}
        {tab === "税率" && <TaxRates isAdmin={staff.role === "admin"} />}
        {tab === "得意先" && <MasterPage def={customers} canWrite={staff.role !== "viewer"} />}
        {tab === "外注先" && <MasterPage def={vendors} canWrite={staff.role !== "viewer"} />}
      </main>
      </div>
    </>
  );
}
