-- ビューが、元のテーブルの列をすべて含むことの確認（`select x.*` のビューは、作成時点の列にしかならないため）
\set ON_ERROR_STOP 1
do $$ declare r record; miss text; begin
  for r in select * from (values ('projects','v_project_summary'),('invoices','v_invoice_balance'),('project_items','v_item_progress')) as t(tbl, vw) loop
    select string_agg(column_name, ', ') into miss from information_schema.columns
     where table_schema = 'public' and table_name = r.tbl
       and column_name not in (select column_name from information_schema.columns where table_schema = 'public' and table_name = r.vw);
    if miss is not null then raise exception 'NG: ビュー % に、テーブル % の列がありません: %', r.vw, r.tbl, miss; end if;
  end loop;
  raise notice 'OK ビュー（v_project_summary・v_invoice_balance・v_item_progress）が、元のテーブルの列をすべて含む（tax_category の欠落の再発防止）';
end $$;

-- 軽減税率の品目を持つ案件を、品目の入力表と同じ読み方（v_item_progress）で読んでも、税区分が保たれる
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x') on conflict do nothing;
insert into public.staff (id, name, role, worker_code) values ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);
insert into customers (name) values ('ビュー検証商事');
insert into projects (customer_id, title, status) select id, 'ビュー検証案件', 'estimate' from customers where name='ビュー検証商事';
insert into project_items (project_id, name, quantity, sale_unit_price, tax_category)
  select id, '軽減品', 1, 100, 'reduced' from projects where title='ビュー検証案件';
do $$ declare t text; begin
  select tax_category into t from v_item_progress where name = '軽減品';
  if t is distinct from 'reduced' then raise exception 'NG: v_item_progress の tax_category が % （reduced のはず）', t; end if;
  raise notice 'OK 軽減税率の品目の税区分が、品目の入力表の読み方（v_item_progress）で保たれる';
end $$;
