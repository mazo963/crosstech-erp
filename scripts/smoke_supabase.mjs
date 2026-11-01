// ローカルの実Supabase（Auth・PostgREST・RLS）に対するスモークテスト
const U = process.env.API_URL, ANON = process.env.ANON_KEY, SVC = process.env.SERVICE_ROLE_KEY;
const ok = (m) => console.log("OK ", m), ng = (m, d) => { console.log("NG ", m, d ?? ""); process.exitCode = 1; };
const call = async (path, { method = "GET", body, token = ANON, prefer, headers = {} } = {}) => {
  const r = await fetch(U + path, { method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
};
const email = `smoke${Date.now()}@example.com`, pw = "Smoke-test-pw-123";
// 1 anon: ping は呼べる。業務データは見えない
let r = await call("/rest/v1/rpc/ping", { method: "POST", body: {} }); r.s === 200 ? ok("anon: rpc/ping が呼べる") : ng("ping", r);
r = await call("/rest/v1/customers?select=id"); (r.s === 401 || r.s === 403 || (r.s === 200 && r.j.length === 0)) ? ok(`anon: 得意先は見えない (HTTP ${r.s})`) : ng("anon が得意先を読めた", r);
// 2 ユーザー作成（管理APIは service_role）→ staff 登録 → ログイン
r = await call("/auth/v1/admin/users", { method: "POST", token: SVC, body: { email, password: pw, email_confirm: true } });
const uid = r.j.id; uid ? ok("Auth: ユーザー作成") : ng("ユーザー作成", r);
r = await call("/rest/v1/staff", { method: "POST", token: SVC, body: { id: uid, name: "松田", role: "admin", worker_code: "matsuda" }, prefer: "return=minimal" }); r.s === 201 ? ok("staff に管理者として登録（service_role）") : ng("staff 登録", r);
r = await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password: pw } });
const T = r.j.access_token; T ? ok("パスワードでログイン") : ng("ログイン", r);
// 3 スタッフ未登録のユーザーは業務データに触れない
const email2 = `nostaff${Date.now()}@example.com`;
r = await call("/auth/v1/admin/users", { method: "POST", token: SVC, body: { email: email2, password: pw, email_confirm: true } });
const T2 = (await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email: email2, password: pw } })).j.access_token;
r = await call("/rest/v1/customers?select=id", { token: T2 }); (r.s === 200 && r.j.length === 0) || r.s >= 400 ? ok("スタッフ未登録のユーザーは業務データを読めない") : ng("未登録ユーザーが読めた", r);
r = await call("/rest/v1/customers", { method: "POST", token: T2, body: { name: "不正" }, prefer: "return=minimal" }); r.s >= 400 ? ok("スタッフ未登録のユーザーは書き込めない") : ng("未登録ユーザーが書けた", r);
// 4 業務フロー（管理者）
r = await call("/rest/v1/customers?select=id", { method: "POST", token: T, body: { name: "スモーク商事", postal_code: "210-0001", address: "神奈川県川崎市1-1", department: "購買部", contact_name: "山田" }, prefer: "return=representation" });
const cust = r.j?.[0]?.id; cust ? ok("得意先を登録") : ng("得意先登録", r);
r = await call("/rest/v1/projects?select=id,project_no", { method: "POST", token: T, body: { customer_id: cust, title: "スモーク案件", status: "estimate", estimate_date: "2026-11-01" }, prefer: "return=representation" });
const proj = r.j?.[0]?.id; proj ? ok(`案件を登録（${r.j[0].project_no}）`) : ng("案件登録", r);
r = await call("/rest/v1/project_items?select=id,product_no", { method: "POST", token: T, body: [{ project_id: proj, name: "プレートA", quantity: 10, sale_unit_price: 3333, cost_unit_price: 1000 }], prefer: "return=representation" });
r.j?.[0]?.product_no ? ok(`品目を登録（製番 ${r.j[0].product_no}）`) : ng("品目登録", r);
r = await call("/rest/v1/rpc/preview_document", { method: "POST", token: T, body: { p_type: "quote", p_source_id: proj } });
(r.s === 200 && r.j.total === 36663) ? ok("見積書の発行イメージ: 税込 36,663 円（DBで計算）") : ng("preview_document", r);
r = await call("/rest/v1/rpc/issue_document", { method: "POST", token: T, body: { p_type: "quote", p_source_id: proj } }); r.s === 200 ? ok("見積書を発行（固定）") : ng("issue_document", r);
r = await call("/rest/v1/rpc/order_project", { method: "POST", token: T, body: { p_project_id: proj } }); (r.s === 200 || r.s === 204) ? ok("受注にする") : ng("order_project", r);
r = await call("/rest/v1/rpc/deliver_all", { method: "POST", token: T, body: { p_project_id: proj, p_delivered_on: "2026-11-05" } }); const dn = r.j; r.s === 200 ? ok("全数納品") : ng("deliver_all", r);
r = await call("/rest/v1/rpc/create_invoice_for_project", { method: "POST", token: T, body: { p_project_id: proj, p_issue_date: "2026-11-06" } }); const inv = r.j; r.s === 200 ? ok("請求書を作成") : ng("create_invoice_for_project", r);
r = await call("/rest/v1/rpc/issue_invoice", { method: "POST", token: T, body: { p_invoice_id: inv } }); r.s === 200 || r.s === 204 ? ok("請求書を発行済みにする") : ng("issue_invoice", r);
r = await call("/rest/v1/rpc/issue_document", { method: "POST", token: T, body: { p_type: "invoice", p_source_id: inv } }); r.s === 200 ? ok("請求書の帳票を発行（固定）") : ng("請求書の帳票", r);
r = await call("/rest/v1/rpc/record_payment", { method: "POST", token: T, body: { p_customer_id: cust, p_received_on: "2026-11-30", p_amount: 36663, p_method: "bank", p_bank_name: "A銀行", p_account_no: "1234567" } }); r.s === 200 ? ok("入金を登録（自動消込）") : ng("record_payment", r);
r = await call("/rest/v1/v_invoice_balance?select=invoice_no,total,balance", { token: T }); (r.s === 200 && r.j.some((x) => Number(x.balance) === 0)) ? ok("請求残高が 0 になった") : ng("請求残高", r);
r = await call("/rest/v1/v_dashboard?select=*", { token: T, headers: { Accept: "application/vnd.pgrst.object+json" } }); r.s === 200 ? ok("ダッシュボードを取得") : ng("v_dashboard", r);
// 5 固定内容は書き換えられない（管理者でも）
r = await call("/rest/v1/issued_documents?doc_type=eq.quote", { method: "PATCH", token: T, body: { doc_no: "X" }, prefer: "return=minimal" }); r.s >= 400 ? ok(`発行済み帳票は更新できない (HTTP ${r.s})`) : ng("発行済み帳票が更新できた", r);
r = await call("/rest/v1/issued_documents?doc_type=eq.quote", { method: "DELETE", token: T, prefer: "return=minimal" }); r.s >= 400 ? ok(`発行済み帳票は削除できない (HTTP ${r.s})`) : ng("発行済み帳票が削除できた", r);
// 6 閲覧のみは書き込めない
const e3 = `viewer${Date.now()}@example.com`; const v = await call("/auth/v1/admin/users", { method: "POST", token: SVC, body: { email: e3, password: pw, email_confirm: true } });
await call("/rest/v1/staff", { method: "POST", token: SVC, body: { id: v.j.id, name: "閲覧", role: "viewer", worker_code: "other" }, prefer: "return=minimal" });
const T3 = (await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email: e3, password: pw } })).j.access_token;
r = await call("/rest/v1/customers?select=id", { token: T3 }); r.s === 200 && r.j.length >= 1 ? ok("閲覧のみ: 読める") : ng("viewer が読めない", r);
r = await call("/rest/v1/customers", { method: "POST", token: T3, body: { name: "閲覧が登録" }, prefer: "return=minimal" }); r.s >= 400 ? ok("閲覧のみ: 書き込めない") : ng("viewer が書けた", r);
console.log(process.exitCode ? "== 不合格あり ==" : "== すべて合格 ==");
