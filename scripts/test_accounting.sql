-- 会計データ出力用ビュー（v_acct_sales / v_acct_payments）の検証（ローカルのみ）
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x'),('00000000-0000-0000-0000-000000000004','viewer@x') on conflict do nothing;
insert into public.staff (id, name, role, worker_code) values
  ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda'),
  ('00000000-0000-0000-0000-000000000004','閲覧','viewer','other') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);

insert into customers (code, name) values ('A001', '会計商事');
insert into projects (customer_id, title, status) select id, '会計案件', 'ordered' from customers where name='会計商事';
insert into project_items (project_id, name, quantity, sale_unit_price) select id, '品1', 10, 1000 from projects where title='会計案件';
insert into project_items (project_id, name, quantity, sale_unit_price, tax_category) select id, '品2', 3, 500, 'reduced' from projects where title='会計案件';
select deliver_all((select id from projects where title='会計案件'), '2026-12-01') as dn \gset
select create_invoice_for_project((select id from projects where title='会計案件'), '2026-12-02') as inv \gset
select set_config('t.inv', :'inv', false);

-- 下書きは売上に出ない。発行済みにすると、税率ごとに1行出る（消費税は請求書の保存値のまま）
do $$ declare n int; begin
  select count(*) into n from v_acct_sales where invoice_id = current_setting('t.inv')::uuid;
  if n <> 0 then raise exception 'NG: 下書きの請求書が売上に出た'; end if;
  perform issue_invoice(current_setting('t.inv')::uuid);
  select count(*) into n from v_acct_sales where invoice_id = current_setting('t.inv')::uuid;
  if n <> 2 then raise exception 'NG: 税率別の2行になっていない (%)', n; end if;
  raise notice 'OK 売上: 下書きは出ず、発行済みの請求書が税率ごとに1行出る';
end $$;

do $$ declare r record; sumg numeric; tot numeric; sumtax numeric; invtax numeric; begin
  select sum(gross_amount), max(invoice_total), sum(tax_amount), max(invoice_tax) into sumg, tot, sumtax, invtax
    from v_acct_sales where invoice_id = current_setting('t.inv')::uuid;
  if sumg <> tot or sumtax <> invtax then raise exception 'NG: 税率別の合計が請求書の合計と合わない (% / % , % / %)', sumg, tot, sumtax, invtax; end if;
  select * into r from v_acct_sales where invoice_id = current_setting('t.inv')::uuid and is_reduced;
  if r.customer_code <> 'A001' or r.customer_name <> '会計商事' or r.taxable_amount <> 1500 or r.tax_rate <> 0.08 then raise exception 'NG: 軽減税率の行 %', to_jsonb(r); end if;
  raise notice 'OK 売上: 税率別の課税額・消費税の合計が、請求書の合計と一致する（再計算ではなく保存値）';
end $$;

-- 入金: 消込先の請求書番号が付く。取消すると voided になり、売掛の残高は戻る
select record_payment((select id from customers where name='会計商事'), '2026-12-20', 10000, 330, 'bank', null, 'A銀行', '1234567') as pay \gset
select set_config('t.pay', :'pay', false);
do $$ declare r record; begin
  select * into r from v_acct_payments where payment_id = current_setting('t.pay')::uuid;
  if r.amount <> 10000 or r.fee <> 330 or r.cleared_amount <> 10330 or r.bank_name <> 'A銀行' or r.voided then raise exception 'NG: 入金の行 %', to_jsonb(r); end if;
  if r.allocated_invoices is null or r.allocated_invoices not like 'INV%（10330円）' then raise exception 'NG: 消込先 %', r.allocated_invoices; end if;
  raise notice 'OK 入金: 金額・手数料・入金銀行・消込先の請求書番号が出る';
end $$;
select void_payment(current_setting('t.pay')::uuid, '誤入力') ;
do $$ declare r record; begin
  select * into r from v_acct_payments where payment_id = current_setting('t.pay')::uuid;
  if not r.voided or r.void_reason <> '誤入力' then raise exception 'NG: 取消の入金 %', to_jsonb(r); end if;
  raise notice 'OK 入金: 取消すると voided と理由が出る（行は残る）';
end $$;

-- 取消済みの請求書は status = void で残る。閲覧のみでも読める。anon は読めない
select void_invoice(current_setting('t.inv')::uuid, 'テスト取消');
do $$ declare n int; begin
  select count(*) into n from v_acct_sales where invoice_id = current_setting('t.inv')::uuid and status = 'void';
  if n <> 2 then raise exception 'NG: 取消の請求書が void で残っていない (%)', n; end if;
  raise notice 'OK 売上: 取消済みの請求書は status=void で残る';
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004', false);
do $$ declare n int; begin
  select count(*) into n from v_acct_sales;
  if n = 0 then raise exception 'NG: 閲覧のみが売上を読めない'; end if;
  raise notice 'OK 閲覧のみの権限でも、売上・入金の一覧を読める';
end $$;
reset role; set role anon;
do $$ begin
  begin perform 1 from v_acct_sales limit 1; raise exception 'NG: anon が売上を読めた';
  exception when insufficient_privilege then null; end;
  raise notice 'OK anon は売上を読めない';
end $$;
