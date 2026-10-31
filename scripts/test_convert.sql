-- 見積 → 受注 → 納品 → 請求 の変換の検証（ローカルのみ）。単独でも scenario の後でも実行できる。
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x') on conflict do nothing;
insert into public.staff (id, name, role, worker_code) values ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda') on conflict do nothing;
update public.company_settings set tax_rounding = 'floor';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);

insert into public.customers (name, closing_day, payment_month_offset, payment_day, billing_basis)
values ('変換テスト商事', 31, 1, 31, 'per_delivery'), ('変換完納工業', 31, 1, 31, 'on_completion');
insert into public.projects (customer_id, title, status) select id, '案件X', 'estimate' from customers where name='変換テスト商事';
insert into public.projects (customer_id, title, status) select id, '案件Y', 'estimate' from customers where name='変換テスト商事';
insert into public.projects (customer_id, title, status) select id, '案件Z', 'estimate' from customers where name='変換完納工業';
insert into public.projects (customer_id, title, status) select id, '案件空', 'estimate' from customers where name='変換テスト商事';
insert into public.project_items (project_id, name, quantity, sale_unit_price)
select p.id, v.n, v.q, v.pr from projects p join (values ('案件X','X1',10,1000),('案件X','X2',4,2500),('案件Y','Y1',6,1000),('案件Z','Z1',5,2000)) v(t,n,q,pr) on v.t = p.title;

-- 見積を受注にする
do $$ begin
  perform order_project((select id from projects where title='案件空'));
  raise exception 'NG: 品目なしの受注が通った';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 品目のない見積は受注にできない: %', sqlerrm; end $$;
select order_project((select id from projects where title='案件X'), '2026-12-01', 'PO-9');
do $$ declare r record; begin
  select * into r from projects where title='案件X';
  if r.status <> 'ordered' or r.order_date <> '2026-12-01' or r.customer_po_no <> 'PO-9' then raise exception 'NG: 受注 %', to_jsonb(r); end if;
  begin perform order_project(r.id); raise exception 'NG: 二重受注が通った';
  exception when others then if sqlerrm like 'NG:%' then raise; end if; end;
  raise notice 'OK 見積を受注にする（受注日・客先注文番号を設定、二重は不可）';
end $$;

-- 全数納品（見積中の案件でも、そのまま納品書へ。状態は受注になる）
select deliver_all((select id from projects where title='案件Y'), '2026-12-05') as dy \gset
do $$ declare n int; begin
  select count(*) into n from delivery_lines where delivery_id = (select id from deliveries order by created_at desc limit 1);
  if n <> 1 or (select status from projects where title='案件Y') <> 'ordered' then raise exception 'NG: 全数納品 n=%', n; end if;
  if (select progress from v_project_summary where title='案件Y') <> 'delivered' then raise exception 'NG: 納品済みにならない'; end if;
  begin perform deliver_all((select id from projects where title='案件Y')); raise exception 'NG: 納品済みの案件に全数納品が通った';
  exception when others then if sqlerrm like 'NG:%' then raise; end if; end;
  raise notice 'OK 全数納品（見積中の案件から直接。納品済みの案件には不可）';
end $$;
-- 分納してから、残りを全数納品
select record_delivery((select id from projects where title='案件X'), '2026-12-02',
  jsonb_build_array(jsonb_build_object('item_id',(select id from project_items where name='X1'),'quantity',3))) as dx1 \gset
select deliver_all((select id from projects where title='案件X'), '2026-12-10') as dx2 \gset
select set_config('t.dx2', :'dx2', false);
do $$ begin
  if (select quantity from delivery_lines where delivery_id = current_setting('t.dx2')::uuid and project_item_id = (select id from project_items where name='X1')) <> 7 then raise exception 'NG: 残り数量'; end if;
  raise notice 'OK 分納のあと、残りの数量だけを全数納品';
end $$;
do $$ begin
  update projects set status='lost' where title='案件空';
  perform deliver_all((select id from projects where title='案件空'));
  raise exception 'NG';
exception when others then if sqlerrm = 'NG' then raise; end if; raise notice 'OK 失注の案件は納品できない: %', sqlerrm; end $$;

-- 納品単位の請求（納品1回 = 請求書1枚）
select create_invoice_for_delivery(:'dx1', '2026-12-03') as iv1 \gset
select set_config('t.iv1', :'iv1', false), set_config('t.dx1', :'dx1', false);
do $$ declare i record; begin
  select * into i from invoices where id = current_setting('t.iv1')::uuid;
  if i.kind <> 'delivery' or i.period_from <> '2026-12-02' or i.period_to <> '2026-12-02' or i.subtotal <> 3000 or i.tax <> 300 or i.total <> 3300 then raise exception 'NG: 納品単位の請求 %', to_jsonb(i); end if;
  if (select count(*) from invoice_lines where invoice_id = i.id) <> 1 then raise exception 'NG: 明細の数'; end if;
  begin perform create_invoice_for_delivery(current_setting('t.dx1')::uuid); raise exception 'NG: 二重請求が通った';
  exception when others then if sqlerrm like 'NG:%' then raise; end if; end;
  raise notice 'OK 納品単位の請求書（その納品の行だけ・期間は納品日・二重請求は不可）';
end $$;
-- 一覧: 請求済みの納品に請求書番号が出る
do $$ begin
  if (select invoice_no from v_delivery_list where id = current_setting('t.dx1')::uuid) <> (select invoice_no from invoices where id = current_setting('t.iv1')::uuid) then raise exception 'NG: 納品一覧の請求書'; end if;
  if (select invoice_no from v_delivery_list where id = current_setting('t.dx2')::uuid) is not null then raise exception 'NG: 未請求の納品に請求書番号'; end if;
  raise notice 'OK 納品一覧に請求の状況（請求書番号・未請求）が出る';
end $$;

-- 案件単位の請求（未請求の納品をまとめて1枚）
select create_invoice_for_project((select id from projects where title='案件X'), '2026-12-11') as iv2 \gset
select set_config('t.iv2', :'iv2', false);
do $$ declare i record; begin
  select * into i from invoices where id = current_setting('t.iv2')::uuid;
  -- 残りは X1 7個(7,000) + X2 4個(10,000) = 17,000。先に請求した3個(3,000)は含まない
  if i.kind <> 'project' or i.subtotal <> 17000 or i.tax <> 1700 or i.period_from <> '2026-12-10' or i.period_to <> '2026-12-10' then raise exception 'NG: 案件単位の請求 %', to_jsonb(i); end if;
  raise notice 'OK 案件単位の請求書（未請求の納品だけをまとめる。請求済みは含まない）';
end $$;

-- 締め請求は従来どおり。案件・納品単位の請求書の日付に、期間の開始が影響されない
select create_invoice_for_project((select id from projects where title='案件Y'), '2026-12-12') as iv3 \gset
-- 締め請求（従来）: 別の納品を追加し、月末で締める。期間の開始は「前回の締め請求の翌日」（案件・納品単位は数えない → 初回は空）
insert into projects (customer_id, title, status) select id, '案件W', 'ordered' from customers where name='変換テスト商事';
insert into project_items (project_id, name, quantity, sale_unit_price) select id, 'W1', 2, 500 from projects where title='案件W';
select deliver_all((select id from projects where title='案件W'), '2026-12-15');
select create_invoice((select id from customers where name='変換テスト商事'), '2026-12-31', '2026-12-31') as iv4 \gset
select set_config('t.iv4', :'iv4', false);
do $$ declare i record; begin
  select * into i from invoices where id = current_setting('t.iv4')::uuid;
  if i.kind <> 'closing' or i.period_from is not null or i.period_to <> '2026-12-31' or i.subtotal <> 1000 then raise exception 'NG: 締め請求 %', to_jsonb(i); end if;
  raise notice 'OK 締め請求は従来どおり（案件・納品単位の請求書に期間の開始が影響されない）';
end $$;

-- 全数完納の得意先: 案件の全品目を納品するまで、案件・納品単位でも請求できない
select record_delivery((select id from projects where title='案件Z'), '2026-12-06',
  jsonb_build_array(jsonb_build_object('item_id',(select id from project_items where name='Z1'),'quantity',2))) as dz1 \gset
select set_config('t.dz1', :'dz1', false);
do $$ begin
  perform create_invoice_for_delivery(current_setting('t.dz1')::uuid);
  raise exception 'NG: 全数完納前に請求できた';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 全数完納の得意先は、一部納品では請求できない: %', sqlerrm; end $$;
do $$ begin
  perform create_invoice_for_project((select id from projects where title='案件Z'));
  raise exception 'NG: 全数完納前に案件を請求できた';
exception when others then if sqlerrm like 'NG:%' then raise; end if; end $$;
select deliver_all((select id from projects where title='案件Z'), '2026-12-07');
select create_invoice_for_project((select id from projects where title='案件Z')) as iv5 \gset
select set_config('t.iv5', :'iv5', false);
do $$ begin
  if (select subtotal from invoices where id = current_setting('t.iv5')::uuid) <> 10000 then raise exception 'NG: 全数完納後の請求'; end if;
  raise notice 'OK 全数完納の得意先は、全品目の納品後に案件単位で請求できる';
end $$;

-- 取消した納品は請求できない。請求書を取り消せば、その納品は再び請求できる
select void_invoice(:'iv1', '作り直し');
select create_invoice_for_delivery(:'dx1', '2026-12-21') as iv6 \gset
select set_config('t.iv6', :'iv6', false);
do $$ begin
  if (select kind from invoices where id = current_setting('t.iv6')::uuid) <> 'delivery' then raise exception 'NG: 再請求'; end if;
  raise notice 'OK 請求書を取り消すと、その納品を請求し直せる';
end $$;
do $$ begin
  perform void_invoice(current_setting('t.iv6')::uuid, '取消');
  perform void_delivery(current_setting('t.dx1')::uuid, '誤入力');
  perform create_invoice_for_delivery(current_setting('t.dx1')::uuid);
  raise exception 'NG: 取消した納品が請求できた';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 取消した納品は請求できない: %', sqlerrm; end $$;

-- 請求書のプレビュー: 下書きでも見られる。発行（帳票の固定）は発行済みだけ
insert into projects (customer_id, title, status) select id, '案件V', 'ordered' from customers where name='変換テスト商事';
insert into project_items (project_id, name, quantity, sale_unit_price) select id, 'V1', 2, 3000 from projects where title='案件V';
select deliver_all((select id from projects where title='案件V'), '2026-12-22');
select create_invoice_for_project((select id from projects where title='案件V'), '2026-12-22') as ivd \gset
select set_config('t.ivd', :'ivd', false);
do $$ declare pv jsonb; begin
  pv := preview_document('invoice', current_setting('t.ivd')::uuid);
  if (pv->>'total')::numeric <> 6600 or pv->>'doc_no' is null or jsonb_array_length(pv->'tax_breakdown') <> 1 then raise exception 'NG: 下書きのプレビュー %', pv; end if;
  begin perform issue_document('invoice', current_setting('t.ivd')::uuid); raise exception 'NG: 下書きの請求書が発行できた';
  exception when others then if sqlerrm like 'NG:%' then raise; end if; end;
  begin perform preview_document('invoice', current_setting('t.iv1')::uuid); raise exception 'NG: 取消済みのプレビューが通った';
  exception when others then if sqlerrm like 'NG:%' then raise; end if; end;
  raise notice 'OK 請求書は下書きでもプレビューできる（発行は発行済みだけ。取消済みは不可）';
end $$;
