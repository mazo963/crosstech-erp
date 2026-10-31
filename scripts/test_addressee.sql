-- 帳票の宛先（住所・担当部署名・担当者名）の検証（ローカルのみ）。単独でも scenario の後でも実行できる。
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x'),('00000000-0000-0000-0000-000000000004','viewer@x') on conflict do nothing;
insert into public.staff (id, name, role, worker_code) values
  ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda'),
  ('00000000-0000-0000-0000-000000000004','閲覧','viewer','other') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);

insert into customers (name, postal_code, address, department, contact_name) values ('宛先商事', '210-0001', '神奈川県川崎市1-1', '購買部', '山田');
insert into customers (name, postal_code, address, department, contact_name, show_address, show_contact) values ('宛先メール商事', '100-0001', '東京都2-2', '総務部', '田中', false, false);
insert into projects (customer_id, title, status) select id, '宛先案件A', 'ordered' from customers where name='宛先商事';
insert into projects (customer_id, title, status) select id, '宛先案件B', 'ordered' from customers where name='宛先商事';
insert into projects (customer_id, title, status) select id, '宛先案件M', 'ordered' from customers where name='宛先メール商事';
insert into project_items (project_id, name, quantity, sale_unit_price) select id, '品' || right(title,1), 2, 1000 from projects where title like '宛先案件%';
select set_config('t.pa', (select id::text from projects where title='宛先案件A'), false), set_config('t.pb', (select id::text from projects where title='宛先案件B'), false), set_config('t.pm', (select id::text from projects where title='宛先案件M'), false);

-- マスタの値が既定で入る。「表示しない」にした項目は、帳票の内容に入らない
do $$ declare c jsonb; begin
  c := (preview_document('quote', current_setting('t.pa')::uuid))->'customer';
  if c->>'address' <> '神奈川県川崎市1-1' or c->>'postal_code' <> '210-0001' or c->>'department' <> '購買部' or c->>'contact_name' <> '山田' then raise exception 'NG: マスタの値 %', c; end if;
  c := (preview_document('quote', current_setting('t.pm')::uuid))->'customer';
  if c->>'address' is not null or c->>'postal_code' is not null or c->>'contact_name' is not null or c->>'department' <> '総務部' then raise exception 'NG: 表示しない項目 %', c; end if;
  raise notice 'OK 得意先マスタの住所・担当部署・担当者が帳票に入る（マスタで「表示しない」にした項目は入らない）';
end $$;

-- 帳票ごとの変更: 値の上書きと、表示する／しない（マスタは変わらない）
insert into doc_addressees (doc_type, source_id, department, contact_name, show_address) values ('quote', current_setting('t.pa')::uuid, '営業部', '佐藤', false);
do $$ declare c jsonb; r jsonb; begin
  c := (preview_document('quote', current_setting('t.pa')::uuid))->'customer';
  if c->>'department' <> '営業部' or c->>'contact_name' <> '佐藤' or c->>'address' is not null then raise exception 'NG: 上書き %', c; end if;
  r := resolve_addressee('quote', current_setting('t.pa')::uuid);
  if r->>'source' <> 'document' or r->'master'->>'department' <> '購買部' or r->'values'->>'address' <> '神奈川県川崎市1-1' then raise exception 'NG: 解決結果 %', r; end if;
  if (select department from customers where name='宛先商事') <> '購買部' then raise exception 'NG: マスタが変わった'; end if;
  raise notice 'OK 帳票ごとに担当部署・担当者を変更し、住所を非表示にできる（マスタは変わらない。非表示でも値は保持）';
end $$;

-- 見積書の設定は、納品書・請求書に引き継がれる。納品書・請求書ごとの変更が、あればそちらが優先
select deliver_all((select id from projects where title='宛先案件A'), '2026-12-01') as da \gset
select deliver_all((select id from projects where title='宛先案件B'), '2026-12-01') as db \gset
select set_config('t.da', :'da', false), set_config('t.db', :'db', false);
do $$ declare c jsonb; begin
  c := (preview_document('delivery_note', current_setting('t.da')::uuid))->'customer';
  if c->>'department' <> '営業部' or c->>'contact_name' <> '佐藤' or c->>'address' is not null then raise exception 'NG: 納品書への引き継ぎ %', c; end if;
  if resolve_addressee('delivery_note', current_setting('t.da')::uuid)->>'source' <> 'quote' then raise exception 'NG: 引き継ぎ元'; end if;
  c := (preview_document('delivery_note', current_setting('t.db')::uuid))->'customer';     -- 案件Bは見積書の設定なし → マスタ
  if c->>'department' <> '購買部' or c->>'contact_name' <> '山田' or c->>'address' <> '神奈川県川崎市1-1' then raise exception 'NG: 設定なしはマスタ %', c; end if;
  insert into doc_addressees (doc_type, source_id, contact_name) values ('delivery_note', current_setting('t.da')::uuid, '鈴木');
  c := (preview_document('delivery_note', current_setting('t.da')::uuid))->'customer';
  if c->>'contact_name' <> '鈴木' or resolve_addressee('delivery_note', current_setting('t.da')::uuid)->>'source' <> 'document' then raise exception 'NG: 納品書ごとの変更 %', c; end if;
  raise notice 'OK 見積書の宛先の設定が納品書に引き継がれ、納品書ごとの変更が優先される（設定がなければマスタ）';
end $$;

-- 請求書: 1つの案件だけの請求書は、その案件の見積書の設定を引き継ぐ。複数案件をまとめた請求書はマスタ
select create_invoice_for_project((select id from projects where title='宛先案件A'), '2026-12-02') as ia \gset
select set_config('t.ia', :'ia', false);
do $$ declare c jsonb; begin
  c := (preview_document('invoice', current_setting('t.ia')::uuid))->'customer';
  if c->>'department' <> '営業部' or c->>'contact_name' <> '佐藤' then raise exception 'NG: 請求書への引き継ぎ %', c; end if;
  raise notice 'OK 単一案件の請求書は、見積書の宛先の設定を引き継ぐ';
end $$;
-- 複数の案件をまとめた請求書（締め請求）は、案件の設定を使わず、マスタ（または請求書ごとの変更）
select deliver_all((select id from projects where title='宛先案件M'), '2026-12-03');
-- 案件Bの納品（案件Aは請求済み）
select create_invoice((select id from customers where name='宛先商事'), '2026-12-31', '2026-12-31') as ic \gset
select set_config('t.ic', :'ic', false);
insert into project_items (project_id, name, quantity, sale_unit_price) select id, '追加', 1, 500 from projects where title='宛先案件A';
select deliver_all((select id from projects where title='宛先案件A'), '2026-12-05');
insert into project_items (project_id, name, quantity, sale_unit_price) select id, '追加', 1, 500 from projects where title='宛先案件B';
select deliver_all((select id from projects where title='宛先案件B'), '2026-12-05');
-- 案件A・Bの追加分をまとめる
select create_invoice((select id from customers where name='宛先商事'), '2026-12-31', '2026-12-31') as ic2 \gset
select set_config('t.ic2', :'ic2', false);
do $$ declare c jsonb; begin
  c := (preview_document('invoice', current_setting('t.ic2')::uuid))->'customer';
  if c->>'department' <> '購買部' or c->>'contact_name' <> '山田' or resolve_addressee('invoice', current_setting('t.ic2')::uuid)->>'source' <> 'master' then raise exception 'NG: 複数案件の請求書はマスタ %', c; end if;
  insert into doc_addressees (doc_type, source_id, department, contact_name, show_contact) values ('invoice', current_setting('t.ic2')::uuid, '経理部', '高橋', true);
  c := (preview_document('invoice', current_setting('t.ic2')::uuid))->'customer';
  if c->>'department' <> '経理部' or c->>'contact_name' <> '高橋' then raise exception 'NG: 請求書ごとの変更 %', c; end if;
  raise notice 'OK 複数案件の請求書はマスタ。請求書ごとの変更もできる';
end $$;

-- マスタに戻す（行を削除）と、マスタの値に戻る。変更後に再発行すると、新しい版になる
do $$ declare n0 int; n1 int; q1 uuid; q2 uuid; begin
  q1 := issue_document('quote', current_setting('t.pa')::uuid);
  delete from doc_addressees where doc_type = 'quote' and source_id = current_setting('t.pa')::uuid;
  if (preview_document('quote', current_setting('t.pa')::uuid))->'customer'->>'department' <> '購買部' then raise exception 'NG: マスタに戻らない'; end if;
  q2 := issue_document('quote', current_setting('t.pa')::uuid);
  if q1 = q2 or (select version from issued_documents where id = q2) <> (select version from issued_documents where id = q1) + 1 then raise exception 'NG: 再発行で新しい版にならない'; end if;
  if (select content->'customer'->>'department' from issued_documents where id = q1) <> '営業部' then raise exception 'NG: 旧版の内容が変わった'; end if;
  -- プレビューと発行の内容は一致する
  if preview_document('quote', current_setting('t.pa')::uuid) <> (select content from issued_documents where id = q2) then raise exception 'NG: プレビューと発行の内容'; end if;
  raise notice 'OK マスタに戻すと値が戻り、変更後の再発行は新しい版（旧版の内容は変わらない）。プレビューと発行の内容は一致';
end $$;

-- 権限: 閲覧のみのユーザーは、宛先を変更できない
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004', false);
do $$ begin
  insert into doc_addressees (doc_type, source_id, contact_name) values ('quote', current_setting('t.pb')::uuid, 'x');
  raise exception 'NG: 閲覧専用が宛先を変更できた';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 閲覧専用は宛先を変更できない: %', sqlerrm; end $$;
