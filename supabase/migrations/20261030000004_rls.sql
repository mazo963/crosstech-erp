-- =====================================================================
-- CROSSTECH ERP  権限（Row Level Security）
--   admin  : すべて＋スタッフ・自社情報・操作ログ
--   office : 業務データの登録・更新
--   viewer : 閲覧のみ
--   スタッフ表に登録されていないログインユーザーは何も見えない
-- =====================================================================

create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.staff where id = auth.uid() and active
$$;

create or replace function public.is_staff()  returns boolean language sql stable as $$ select public.current_role_name() is not null $$;
create or replace function public.can_write() returns boolean language sql stable as $$ select public.current_role_name() in ('admin','office') $$;
create or replace function public.is_admin()  returns boolean language sql stable as $$ select public.current_role_name() = 'admin' $$;

-- すべての業務テーブルでRLSを有効化
do $$
declare t text;
begin
  foreach t in array array[
    'company_settings','staff','customers','vendors','doc_counters','projects','project_items',
    'deliveries','delivery_lines','invoices','invoice_lines','payments','payment_allocations',
    'purchases','ai_extractions','audit_log','keepalive'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- 閲覧: スタッフ全員 / 登録・更新: admin・office
do $$
declare t text;
begin
  foreach t in array array[
    'customers','vendors','projects','project_items','deliveries','delivery_lines',
    'invoices','invoice_lines','payments','payment_allocations','purchases','ai_extractions'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_write())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_write()) with check (public.can_write())', t || '_update', t);
  end loop;
end $$;

-- 削除を許すのは「まだ使われていない」データだけ（外部キーが残りを防ぐ）
create policy project_items_delete on public.project_items for delete to authenticated using (public.can_write());
create policy projects_delete      on public.projects      for delete to authenticated using (public.is_admin());
create policy purchases_delete     on public.purchases     for delete to authenticated using (public.can_write());
create policy payments_delete      on public.payments      for delete to authenticated using (public.is_admin());
create policy alloc_delete         on public.payment_allocations for delete to authenticated using (public.is_admin());

-- 自社情報
create policy company_select on public.company_settings for select to authenticated using (public.is_staff());
create policy company_update on public.company_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- スタッフ
create policy staff_select on public.staff for select to authenticated using (public.is_staff());
create policy staff_insert on public.staff for insert to authenticated with check (public.is_admin());
create policy staff_update on public.staff for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- 操作ログは管理者のみ閲覧（書き込みはトリガーのみ）
create policy audit_select on public.audit_log for select to authenticated using (public.is_admin());

-- 採番関数は直接呼ばせない（RPC経由で内部的に使う）
revoke execute on function public.next_doc_no(text, date) from public, anon, authenticated;
grant  execute on function public.next_doc_no(text, date) to authenticated;  -- 列デフォルトの評価に必要

-- 認証なしで呼べるのは ping だけ
revoke execute on all functions in schema public from anon;
grant  execute on function public.ping() to anon;
