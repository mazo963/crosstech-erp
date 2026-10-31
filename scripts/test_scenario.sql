-- 業務シナリオ検証（ローカルのみ）: 見積→受注→分納→締め請求→入金
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x'),('00000000-0000-0000-0000-000000000002','stranger@x');
insert into public.staff (id, name, role, worker_code) values ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda');
update public.company_settings set invoice_reg_no='T1234567890123', tax_rounding='floor';

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);

insert into public.customers (name, closing_day, payment_month_offset, payment_day, billing_basis)
values ('テスト精機', 31, 1, 31, 'per_delivery'), ('完納工業', 20, 1, 10, 'on_completion');

insert into public.projects (customer_id, title, status)
select id, 'プレート加工', 'ordered' from public.customers where name='テスト精機';
insert into public.project_items (project_id, name, quantity, cost_unit_price, sale_unit_price)
select id, 'プレートA', 10, 1200, 3333 from public.projects where title='プレート加工';
insert into public.project_items (project_id, name, quantity, cost_unit_price, sale_unit_price)
select id, 'シャフトB', 3, 0, 15000 from public.projects where title='プレート加工';

select project_no, (select string_agg(product_no, ',' order by line_no) from project_items) as product_nos from projects;

-- 分納1回目: プレートA 4個
select record_delivery((select id from projects limit 1), '2026-10-15',
  jsonb_build_array(jsonb_build_object('item_id',(select id from project_items where name='プレートA'),'quantity',4)));
-- 超過納品は拒否される
do $$ begin
  perform record_delivery((select id from projects limit 1), '2026-10-16',
    jsonb_build_array(jsonb_build_object('item_id',(select id from project_items where name='プレートA'),'quantity',7)));
  raise exception 'NG: 超過納品が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 超過納品を拒否: %', sqlerrm;
end $$;

select project_no, progress, delivery_pct, sales_amount, cost_amount, gross_profit, margin_pct from v_project_summary;

-- 10月末締めの請求書
select create_invoice((select id from customers where name='テスト精機'), '2026-10-31', '2026-10-31') as inv \gset
select invoice_no, period_from, period_to, due_date, subtotal, tax, total from invoices;
-- 同じ納品は二重に請求されない
do $$ begin
  perform create_invoice((select id from customers where name='テスト精機'), '2026-10-31');
  raise exception 'NG: 二重請求が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 二重請求を拒否: %', sqlerrm;
end $$;
-- 請求済みの納品は取消できない
do $$ begin
  perform void_delivery((select id from deliveries limit 1), 'テスト');
  raise exception 'NG';
exception when others then
  if sqlerrm = 'NG' then raise; end if;
  raise notice 'OK 請求済み納品の取消を拒否: %', sqlerrm;
end $$;

select issue_invoice(:'inv');
-- 振込手数料 660円差引で入金
-- 銀行振込は入金銀行・口座番号が必須
do $$ begin
  perform record_payment((select id from customers where name='テスト精機'), '2026-11-30', 14004, 660);
  raise exception 'NG: 銀行情報なしの振込入金が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 銀行情報なしの振込入金を拒否: %', sqlerrm;
end $$;
select record_payment((select id from customers where name='テスト精機'), '2026-11-30', 14004, 660, 'bank', null, 'テスト銀行 本店', '1234567') as pay \gset
select invoice_no, total, allocated, balance, overdue from v_invoice_balance;
select customer_name, ar_balance, unallocated_payment, unbilled_amount from v_customer_balance;

-- 入金済みの請求書は取消できない
do $$ begin
  perform void_invoice((select id from invoices limit 1), 'テスト');
  raise exception 'NG: 入金消込済み請求書の取消が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 入金消込済み請求書の取消を拒否: %', sqlerrm;
end $$;
-- 入金の取消: 理由必須・残高が戻る・二重取消不可・行は残る
do $$ begin
  perform void_payment((select id from payments where not voided limit 1), '  ');
  raise exception 'NG: 理由なしの入金取消が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 理由なしの入金取消を拒否: %', sqlerrm;
end $$;
select void_payment(:'pay', '二重入力');
do $$ declare v_bal numeric; v_un numeric; v_cnt int; begin
  select balance into v_bal from v_invoice_balance limit 1;
  select unallocated_payment into v_un from v_customer_balance where customer_name='テスト精機';
  select count(*) into v_cnt from payments where voided;
  if v_bal <> 14665 then raise exception 'NG: 取消後の残高が戻らない (%)', v_bal; end if;
  if v_un <> 0 then raise exception 'NG: 取消後に前受が残っている (%)', v_un; end if;
  if v_cnt <> 1 then raise exception 'NG: 取消した入金の行が残っていない'; end if;
  raise notice 'OK 入金取消で残高が戻り、入金の行は残る（残高 %）', v_bal;
end $$;
do $$ begin
  perform void_payment((select id from payments where voided limit 1), '再取消');
  raise exception 'NG: 二重取消が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 二重取消を拒否: %', sqlerrm;
end $$;
-- 取消した入金で請求書の取消が可能になり、入金し直すと再び消し込まれる
select record_payment((select id from customers where name='テスト精機'), '2026-12-01', 14665, 0, 'bank', null, 'テスト銀行 本店', '1234567');
select invoice_no, total, allocated, balance from v_invoice_balance;

-- 全数完納の得意先: 一部納品だけでは請求対象にならない
insert into public.projects (customer_id, title, status) select id, '金型部品', 'ordered' from customers where name='完納工業';
insert into public.project_items (project_id, name, quantity, sale_unit_price) select id, '金型部品X', 5, 8000 from projects where title='金型部品';
select record_delivery((select id from projects where title='金型部品'), '2026-10-10',
  jsonb_build_array(jsonb_build_object('item_id',(select id from project_items where name='金型部品X'),'quantity',2)));
do $$ begin
  perform create_invoice((select id from customers where name='完納工業'), '2026-10-20');
  raise exception 'NG';
exception when others then
  if sqlerrm = 'NG' then raise; end if;
  raise notice 'OK 全数完納前は請求しない: %', sqlerrm;
end $$;

select * from v_dashboard;
select calc_period_end('2026-10-22', 20) as p20, calc_period_end('2026-10-22', 31) as p31,
       calc_due_date('2026-10-20', 1, 10) as due_next10, calc_due_date('2026-10-31', 2, 31) as due_2m_end;

-- RLS: スタッフ未登録のユーザーには何も見えない・書けない
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002', false);
select count(*) as stranger_sees_projects from projects;
do $$ begin
  insert into customers (name) values ('不正');
  raise exception 'NG';
exception when others then
  if sqlerrm = 'NG' then raise; end if;
  raise notice 'OK 未登録ユーザーの書込を拒否: %', sqlerrm;
end $$;
reset role;
set role anon;
select ping() is not null as anon_ping_ok;
do $$ begin perform count(*) from public.projects; raise exception 'NG';
exception when others then if sqlerrm='NG' then raise; end if; raise notice 'OK anonは業務データを読めない: %', sqlerrm; end $$;
