import { configured, supabase } from "./lib/supabase";
import { useSession } from "./lib/useSession";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";

export function App() {
  const { session, staff, loading } = useSession();

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
      <main>
        <h2>ダッシュボード</h2>
        <Dashboard />
      </main>
    </>
  );
}
