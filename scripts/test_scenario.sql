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

-- 帳票の発行: 内容の固定・版管理・改ざん防止・取消の連動・PDF保存・検索
select issue_document('invoice', (select id from invoices limit 1)) as doc1 \gset
select issue_document('invoice', (select id from invoices limit 1)) as doc1b \gset
select set_config('t.doc1', :'doc1', false), set_config('t.doc1b', :'doc1b', false);
select issue_document('quote', (select id from projects where title='プレート加工')) as q1 \gset
select issue_document('delivery_note', (select id from deliveries order by delivered_on limit 1)) as dn1 \gset
do $$ declare r record; begin
  select * into r from issued_documents where id = current_setting('t.doc1')::uuid;
  if current_setting('t.doc1') <> current_setting('t.doc1b') then raise exception 'NG: 同じ内容で新しい版が作られた'; end if;
  if r.version <> 1 or r.amount <> 14665 or r.counterparty_name <> 'テスト精機' then raise exception 'NG: 検索項目が正しくない %', r; end if;
  if r.content_sha256 <> encode(sha256(convert_to(r.content::text,'UTF8')),'hex') then raise exception 'NG: ハッシュ不一致'; end if;
  if r.content->'tax_breakdown'->0->>'tax' <> '1333' or (r.content->>'official')::boolean then raise exception 'NG: 請求書の記載内容 %', r.content; end if;
  raise notice 'OK 請求書を固定発行（同内容は同じ版、ハッシュ一致、控え扱い、検索項目あり）';
end $$;
do $$ begin
  update issued_documents set amount = 1 where doc_type='invoice';
  raise exception 'NG: 発行済み帳票の更新が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 発行済み帳票の更新を拒否: %', sqlerrm;
end $$;
do $$ begin
  delete from issued_documents;
  raise exception 'NG: 発行済み帳票の削除が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 発行済み帳票の削除を拒否: %', sqlerrm;
end $$;
reset role;
do $$ begin
  update issued_documents set content = '{}'::jsonb;
  raise exception 'NG: 権限を持つ者でも内容を書き換えられた';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 特権ロールでも固定内容の書換えを拒否: %', sqlerrm;
end $$;
set role authenticated;
-- 自社情報が変わったら、再発行で新しい版（旧版は残る）
update company_settings set address = '変更後の住所' where id = 1;
select issue_document('invoice', (select id from invoices limit 1)) as doc2 \gset
select set_config('t.doc2', :'doc2', false);
do $$ declare v int; n int; begin
  select version into v from issued_documents where id = current_setting('t.doc2')::uuid;
  select count(*) into n from issued_documents where doc_type='invoice';
  if v <> 2 or n <> 2 then raise exception 'NG: 版管理 v=% n=%', v, n; end if;
  raise notice 'OK 内容が変わると版2を発行し、版1も残る';
end $$;
-- 交付記録とPDF保存
insert into document_deliveries (document_id, method, recipient) values (:'doc2', 'email_pdf', 'test@example.com') returning id as dlv \gset
select attach_document_pdf(:'doc2', :'dlv', 'INV2610-0001.pdf', encode(convert_to('%PDF-1.4 test', 'UTF8'), 'base64')) as pdf \gset
do $$ begin
  perform attach_document_pdf((select id from issued_documents limit 1), null, 'x.pdf', encode(convert_to('not pdf', 'UTF8'), 'base64'));
  raise exception 'NG: PDF以外が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK PDF以外を拒否: %', sqlerrm;
end $$;
select set_config('t.pdf', :'pdf', false);
do $$ declare f record; begin
  select * into f from document_files where id = current_setting('t.pdf')::uuid;
  if f.sha256 <> encode(sha256(convert_to('%PDF-1.4 test','UTF8')),'hex') or f.size_bytes <> 13 then raise exception 'NG: PDFのハッシュ/サイズ'; end if;
  if convert_from(decode(document_file_base64(current_setting('t.pdf')::uuid),'base64'),'UTF8') <> '%PDF-1.4 test' then raise exception 'NG: PDFの取り出し'; end if;
  raise notice 'OK 送付PDFをハッシュ付きで保存し、そのまま取り出せる';
end $$;
do $$ begin
  update document_deliveries set recipient = 'x';
  raise exception 'NG: 交付記録の更新が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 交付記録は追記のみ: %', sqlerrm;
end $$;
-- 出力ビュー（発行済み帳票・送付PDF）
do $$ declare r record; begin
  select * into r from v_export_issued where id = current_setting('t.doc2')::uuid;
  if r.deliveries not like '%PDF test@example.com%' or r.sent_pdf_count <> 1 or r.doc_no <> 'INV2610-0001' then raise exception 'NG: 帳票の出力ビュー %', to_jsonb(r); end if;
  select * into r from v_export_sent_files where id = current_setting('t.pdf')::uuid;
  if r.file_name <> 'INV2610-0001.pdf' or r.delivery_method <> 'email_pdf' or r.timestamp_status <> 'pending' or r.sha256 is null then raise exception 'NG: 送付PDFの出力ビュー %', to_jsonb(r); end if;
  raise notice 'OK 帳票・送付PDFの出力ビュー（交付記録・ハッシュ・タイムスタンプ状況）';
end $$;
-- 検索（取引年月日の範囲・金額の範囲・取引先の組合せ）
do $$ declare n int; begin
  select count(*) into n from issued_documents
   where doc_date between '2026-10-01' and '2026-10-31' and amount between 10000 and 20000 and counterparty_name like 'テスト%';
  if n <> 2 then raise exception 'NG: 検索結果 %', n; end if;
  raise notice 'OK 日付・金額・取引先の組合せ検索';
end $$;
-- 元の請求書を取消すと、固定済みの帳票も取消になる（行は残る）
select void_payment((select id from payments where not voided limit 1), '帳票取消テスト');
select void_invoice((select id from invoices limit 1), '帳票取消テスト');
do $$ declare n int; m int; begin
  select count(*) into n from issued_documents where doc_type='invoice' and voided;
  select count(*) into m from issued_documents where doc_type='invoice';
  if n <> 2 or m <> 2 then raise exception 'NG: 請求書取消に帳票が連動しない n=% m=%', n, m; end if;
  raise notice 'OK 請求書の取消で帳票も取消（履歴は残る）';
end $$;

-- RLS: スタッフ未登録のユーザーには何も見えない・書けない
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002', false);
select count(*) as stranger_sees_projects from projects;
select count(*) as stranger_sees_documents from issued_documents;
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
