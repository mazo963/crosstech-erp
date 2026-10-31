-- 複数税率の検証（ローカルのみ）。標準10%・軽減8%・将来の1%（例）が混在する請求書を、税率ごとに1回だけ端数処理する。
-- scripts/test_scenario.sql の後でも、単独でも実行できる。
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x'),('00000000-0000-0000-0000-000000000003','office@x') on conflict do nothing;
insert into public.staff (id, name, role, worker_code) values
  ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda'),
  ('00000000-0000-0000-0000-000000000003','事務','office','other') on conflict do nothing;
update public.company_settings set invoice_reg_no='T1234567890123', tax_rounding='floor';

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);

-- 初期の税率
do $$ begin
  if public.tax_rate_on('standard','2026-12-20') <> 0.10 or public.tax_rate_on('reduced','2026-12-20') <> 0.08 then raise exception 'NG: 初期税率'; end if;
  raise notice 'OK 標準10%% / 軽減8%% が登録済み';
end $$;
do $$ begin
  perform public.tax_rate_on('standard','2019-09-30');
  raise exception 'NG: 税率が無い日付でエラーにならない';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 税率が無い日付は拒否: %', sqlerrm;
end $$;

insert into public.customers (name, closing_day, payment_month_offset, payment_day, billing_basis)
values ('税率テスト商事', 31, 1, 31, 'per_delivery');
insert into public.projects (customer_id, title, status, estimate_date)
select id, '混在税率', 'ordered', '2027-01-15' from public.customers where name='税率テスト商事';
insert into public.project_items (project_id, name, quantity, sale_unit_price, tax_category)
select p.id, v.n, v.q, v.pr, v.c from public.projects p,
  (values ('A標準', 10, 1000, 'standard'), ('B軽減', 7, 500, 'reduced'), ('C標準', 3, 15, 'standard')) as v(n, q, pr, c)
 where p.title = '混在税率';

-- 2026-12-20: 税率変更前
select record_delivery((select id from projects where title='混在税率'), '2026-12-20', jsonb_build_array(
  jsonb_build_object('item_id',(select id from project_items where name='A標準'),'quantity',10),
  jsonb_build_object('item_id',(select id from project_items where name='B軽減'),'quantity',3),
  jsonb_build_object('item_id',(select id from project_items where name='C標準'),'quantity',1)));
select record_delivery((select id from projects where title='混在税率'), '2026-12-21', jsonb_build_array(
  jsonb_build_object('item_id',(select id from project_items where name='C標準'),'quantity',1)));
select record_delivery((select id from projects where title='混在税率'), '2026-12-22', jsonb_build_array(
  jsonb_build_object('item_id',(select id from project_items where name='C標準'),'quantity',1)));

-- 軽減税率を 2027-01-01 から 1%（例）に変更
select set_tax_rate('reduced', 0.01, '2027-01-01');
do $$ begin
  if public.tax_rate_on('reduced','2026-12-31') <> 0.08 or public.tax_rate_on('reduced','2027-01-01') <> 0.01 then raise exception 'NG: 税率の切替'; end if;
  if (select count(*) from tax_rate_periods where category_code='reduced') <> 2 then raise exception 'NG: 期間が2件でない'; end if;
  if (select valid_to from tax_rate_periods where category_code='reduced' and valid_from='2019-10-01') <> '2026-12-31' then raise exception 'NG: 旧期間が閉じていない'; end if;
  raise notice 'OK 軽減税率を 2027-01-01 から1%%に変更（前の期間は前日で閉じる）';
end $$;
-- 変更後の納品は新税率、変更前に固定した納品行は変わらない
select record_delivery((select id from projects where title='混在税率'), '2027-01-10', jsonb_build_array(
  jsonb_build_object('item_id',(select id from project_items where name='B軽減'),'quantity',4)));
do $$ begin
  if (select string_agg(dl.tax_rate::text, ',' order by d.delivered_on) from delivery_lines dl join deliveries d on d.id=dl.delivery_id
        join project_items i on i.id=dl.project_item_id where i.name='B軽減') <> '0.0800,0.0100' then raise exception 'NG: 納品行の税率固定'; end if;
  raise notice 'OK 納品行の税率は納品日時点で固定（旧0.08・新0.01）';
end $$;

-- 混在請求書: 税率ごとに集計し、税率ごとに1回だけ端数処理
select create_invoice((select id from customers where name='税率テスト商事'), '2027-01-31', '2027-01-31') as inv \gset
do $$ declare i record; begin
  select * into i from invoices where invoice_no = (select invoice_no from invoices order by created_at desc limit 1);
  if (select count(*) from invoice_tax_summary where invoice_id = i.id) <> 3 then raise exception 'NG: 税率別集計が3行でない'; end if;
  if (select tax_amount from invoice_tax_summary where invoice_id=i.id and tax_rate=0.10) <> 1004 then raise exception 'NG: 10%%の消費税（税率ごとに1回の端数処理）'; end if;
  if (select tax_amount from invoice_tax_summary where invoice_id=i.id and tax_rate=0.08) <> 120 then raise exception 'NG: 8%%'; end if;
  if (select tax_amount from invoice_tax_summary where invoice_id=i.id and tax_rate=0.01) <> 20 then raise exception 'NG: 1%%'; end if;
  if i.subtotal <> 13545 or i.tax <> 1144 or i.total <> 14689 or i.tax_rate is not null then raise exception 'NG: 合計 % % % %', i.subtotal, i.tax, i.total, i.tax_rate; end if;
  raise notice 'OK 3税率の混在請求書: 小計13,545 税1,144（10%%:1,004 / 8%%:120 / 1%%:20）合計14,689';
end $$;
select issue_invoice(:'inv');
select issue_document('invoice', :'inv') as d1 \gset
do $$ declare c jsonb; begin
  select content into c from issued_documents where doc_type='invoice' order by issued_at desc limit 1;
  if jsonb_array_length(c->'tax_breakdown') <> 3 or (c->'tax_breakdown'->0->>'rate')::numeric <> 0.10
     or (c->'tax_breakdown'->2->>'rate')::numeric <> 0.01 or (c->'tax_breakdown'->1->>'reduced')::boolean is not true then
    raise exception 'NG: 帳票の税率別内訳 %', c->'tax_breakdown'; end if;
  if (select count(*) from jsonb_array_elements(c->'lines') l where (l->>'is_reduced')::boolean) <> 2 then raise exception 'NG: 軽減税率の明細の印'; end if;
  raise notice 'OK 請求書の帳票に税率別内訳と軽減税率の明細を固定';
end $$;
-- 見積書は見積日（2027-01-15）時点の税率
select issue_document('quote', (select id from projects where title='混在税率')) as q \gset
do $$ declare c jsonb; begin
  select content into c from issued_documents where doc_type='quote' order by issued_at desc limit 1;
  if (c->>'subtotal')::numeric <> 13545 or (c->>'tax')::numeric <> 1039 or (c->>'total')::numeric <> 14584 then raise exception 'NG: 見積書の税 %', c; end if;
  raise notice 'OK 見積書は見積日時点の税率で計算（標準1,004 + 軽減1%%:35）';
end $$;

-- 守り: 管理者以外は変更不可、さかのぼり不可、期間の重複不可
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003', false);
do $$ begin
  perform set_tax_rate('standard', 0.12, '2028-01-01');
  raise exception 'NG: 管理者以外が税率を変更できた';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 管理者以外の税率変更を拒否: %', sqlerrm;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);
do $$ begin
  perform set_tax_rate('reduced', 0.05, '2027-01-05');
  raise exception 'NG: 納品済みの日付へのさかのぼり変更が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 納品済みの日付へのさかのぼり変更を拒否: %', sqlerrm;
end $$;
do $$ begin
  insert into tax_rate_periods (category_code, rate, valid_from) values ('standard', 0.12, '2026-01-01');
  raise exception 'NG: 期間の重複が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 適用期間の重複を拒否: %', sqlerrm;
end $$;
