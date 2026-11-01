-- 帳票の記載項目（有効期限・納期・支払条件・振込先・納入場所・客先注文番号・ロゴ・担当者・FAX・社印）の検証（ローカルのみ）
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x'),('00000000-0000-0000-0000-000000000003','office@x') on conflict do nothing;
insert into public.staff (id, name, role, worker_code) values
  ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda'),
  ('00000000-0000-0000-0000-000000000003','事務','office','other') on conflict do nothing;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);

update company_settings set fax='044-111-2222', contact_person='松田', quote_valid_days=30,
  logo_data='data:image/png;base64,iVBORw0KGgo=', seal_data='data:image/png;base64,iVBORw0KGgo=' where id=1;
insert into bank_accounts (label, bank_name, branch_name, account_type, account_number, account_holder, is_default)
  values ('A銀行 普通','A銀行','川崎支店','普通','1234567','カ）クロステック', true);
insert into bank_accounts (label, bank_name, branch_name, account_type, account_number, account_holder)
  values ('B信金 当座','B信用金庫','本店','当座','7654321','カ）クロステック');
insert into customers (name, closing_day, payment_month_offset, payment_day, default_delivery_place) values ('記載商事', 31, 1, 31, '川崎工場 受入口');
insert into projects (customer_id, title, status, estimate_date, due_date, customer_po_no)
  select id, '記載案件', 'ordered', '2026-12-01', '2026-12-20', 'PO-777' from customers where name='記載商事';
insert into project_items (project_id, name, quantity, sale_unit_price) select id, '品', 2, 1000 from projects where title='記載案件';
select set_config('t.p', (select id::text from projects where title='記載案件'), false);

-- 既定: 自社情報・振込先（既定の口座）・得意先・案件から入る
do $$ declare c jsonb; begin
  c := preview_document('quote', current_setting('t.p')::uuid);
  if c->>'valid_until' <> '2026-12-31' or c->>'due_date' <> '2026-12-20' then raise exception 'NG: 見積書の有効期限・納期 %', c; end if;
  if c->'issuer'->>'fax' <> '044-111-2222' or c->'issuer'->>'contact_person' <> '松田' or c->'issuer'->>'logo' is null or c->'issuer'->>'seal' is null then raise exception 'NG: 自社項目 %', c->'issuer'; end if;
  raise notice 'OK 見積書: 有効期限（見積日＋30日）・納期・FAX・担当者・ロゴ・社印が既定で入る';
end $$;

-- 表示しない項目は、内容に入らない（値は残る）。帳票ごとの値の上書きもできる
insert into doc_options (doc_type, source_id, valid_until, show_logo, show_seal, show_lead_time, contact_person)
  values ('quote', current_setting('t.p')::uuid, '2027-01-15', false, false, false, '佐藤');
do $$ declare c jsonb; r jsonb; begin
  c := preview_document('quote', current_setting('t.p')::uuid);
  if c->>'valid_until' <> '2027-01-15' or c->'issuer'->>'contact_person' <> '佐藤' then raise exception 'NG: 上書き %', c; end if;
  if c->'issuer'->>'logo' is not null or c->'issuer'->>'seal' is not null or c->>'due_date' is not null then raise exception 'NG: 非表示 %', c; end if;
  r := resolve_doc_options('quote', current_setting('t.p')::uuid);
  if r->>'source' <> 'document' or r->'defaults'->>'valid_until' <> '2026-12-31' or not (r->>'has_logo')::boolean then raise exception 'NG: 解決結果 %', r; end if;
  if (select contact_person from company_settings where id=1) <> '松田' then raise exception 'NG: 既定が変わった'; end if;
  raise notice 'OK 値の上書きと、ロゴ・社印・納期の非表示（既定の設定は変わらない）';
end $$;

-- 納品書: 納入場所・客先注文番号。請求書: さらに支払条件・振込先（既定の口座→帳票ごとに選択）
select deliver_all((select id from projects where title='記載案件'), '2026-12-05') as dn \gset
select set_config('t.dn', :'dn', false);
select create_invoice_for_project((select id from projects where title='記載案件'), '2026-12-06') as inv \gset
select set_config('t.inv', :'inv', false);
do $$ declare c jsonb; begin
  c := preview_document('delivery_note', current_setting('t.dn')::uuid);
  if c->>'delivery_place' <> '川崎工場 受入口' or c->>'customer_po_no' <> 'PO-777' then raise exception 'NG: 納品書 %', c; end if;
  c := preview_document('invoice', current_setting('t.inv')::uuid);
  if c->>'delivery_place' <> '川崎工場 受入口' or c->>'customer_po_no' <> 'PO-777' then raise exception 'NG: 請求書の納入場所・注文番号 %', c; end if;
  if c->>'payment_terms' <> '末日締め　翌月末日払い' then raise exception 'NG: 支払条件 %', c->>'payment_terms'; end if;
  if c->'bank'->>'bank_name' <> 'A銀行' or c->'bank'->>'account_number' <> '1234567' then raise exception 'NG: 既定の振込先 %', c->'bank'; end if;
  raise notice 'OK 納品書・請求書: 納入場所・客先注文番号、請求書: 支払条件（得意先の締め・支払から）と既定の振込先';
end $$;

insert into doc_options (doc_type, source_id, bank_account_id, payment_terms, show_po_no)
  select 'invoice', current_setting('t.inv')::uuid, id, '納品月末現金払い', false from bank_accounts where label='B信金 当座';
do $$ declare c jsonb; begin
  c := preview_document('invoice', current_setting('t.inv')::uuid);
  if c->'bank'->>'bank_name' <> 'B信用金庫' or c->>'payment_terms' <> '納品月末現金払い' or c->>'customer_po_no' is not null then raise exception 'NG: 請求書ごとの変更 %', c; end if;
  update doc_options set show_bank = false, show_payment_terms = false where doc_type='invoice' and source_id = current_setting('t.inv')::uuid;
  c := preview_document('invoice', current_setting('t.inv')::uuid);
  if c->'bank' <> 'null'::jsonb or c->>'payment_terms' is not null or c->>'bank_info' is not null then raise exception 'NG: 振込先・支払条件の非表示 %', c; end if;
  raise notice 'OK 請求書ごとに、振込先の口座を選び、支払条件を書き換え、非表示にできる';
end $$;

-- 発行すると、表示した項目だけが固定される。発行後に設定を変えても、発行済みの内容は変わらない
update doc_options set show_bank = true, show_payment_terms = true, show_po_no = true where doc_type='invoice' and source_id = current_setting('t.inv')::uuid;
do $$ declare d uuid; n text; begin
  perform issue_invoice(current_setting('t.inv')::uuid);
  d := issue_document('invoice', current_setting('t.inv')::uuid);
  update bank_accounts set bank_name = '変更後銀行' where label='B信金 当座';
  select content->'bank'->>'bank_name' into n from issued_documents where id = d;
  if n <> 'B信用金庫' then raise exception 'NG: 発行済みの内容が変わった %', n; end if;
  raise notice 'OK 発行済みの帳票の振込先は、発行後にマスタを変えても変わらない';
end $$;

-- 権限: 振込先の登録は管理者のみ。閲覧者は記載項目を変更できない
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003', false);
do $$ begin
  begin insert into bank_accounts (label, bank_name, account_number, account_holder) values ('x','x','1','x'); raise exception 'NG: 事務が口座を登録できた';
  exception when insufficient_privilege or others then if sqlerrm like 'NG:%' then raise; end if; end;
  raise notice 'OK 振込先口座の登録は管理者のみ';
end $$;
