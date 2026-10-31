-- 受領書類（電子取引・スキャナ保存）とタイムスタンプの検証（ローカルのみ）。単独でも scenario の後でも実行できる。
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-000000000001','admin@x'),('00000000-0000-0000-0000-000000000002','stranger@x'),
  ('00000000-0000-0000-0000-000000000004','viewer@x') on conflict do nothing;
insert into public.staff (id, name, role, worker_code) values
  ('00000000-0000-0000-0000-000000000001','松田','admin','matsuda'),
  ('00000000-0000-0000-0000-000000000004','閲覧','viewer','other') on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001', false);

-- 営業日の加算（2026-10-30 金曜 + 7営業日 = 2026-11-10 火曜）
do $$ begin
  if public.add_business_days('2026-10-30', 7) <> '2026-11-10' then raise exception 'NG: 営業日の加算 %', public.add_business_days('2026-10-30', 7); end if;
  raise notice 'OK 営業日の加算（土日を除く）';
end $$;

-- 電子取引で受け取った請求書
select register_received_document(jsonb_build_object('kind','electronic','doc_category','invoice','doc_date',current_date-10,'amount',110000,
  'counterparty_name','テスト外注','received_on',current_date-3,'channel','email','file_name','inv1.pdf'),
  encode(convert_to('%PDF-1.4 inv1','UTF8'),'base64')) as e1 \gset
select set_config('t.e1', :'e1', false);
do $$ declare r record; begin
  select * into r from received_documents where id = current_setting('t.e1')::uuid;
  if r.importance <> 'important' or r.kind <> 'electronic' or r.input_timeliness <> 'early' then raise exception 'NG: 区分 %', r.importance; end if;
  if r.sha256 <> encode(sha256(convert_to('%PDF-1.4 inv1','UTF8')),'hex') then raise exception 'NG: ハッシュ'; end if;
  if r.deadline_early <> public.add_business_days(r.received_on, 7) or r.deadline_max <> public.add_business_days((r.received_on + interval '2 months')::date, 7) then raise exception 'NG: 期限'; end if;
  if r.scanned_on is not null or r.resolution_dpi is not null then raise exception 'NG: 電子取引にスキャン項目'; end if;
  raise notice 'OK 電子取引を登録（重要書類・ハッシュ・入力期限をDBが計算）';
end $$;
do $$ begin
  perform register_received_document(jsonb_build_object('kind','electronic','doc_category','invoice','doc_date',current_date,'amount',1,
    'counterparty_name','x','received_on',current_date,'channel','email','file_name','dup.pdf'), encode(convert_to('%PDF-1.4 inv1','UTF8'),'base64'));
  raise exception 'NG: 同じファイルの二重登録が通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 同じファイルの二重登録を拒否: %', sqlerrm;
end $$;
do $$ begin
  perform register_received_document(jsonb_build_object('kind','electronic','doc_category','quote','doc_date',current_date,'amount',1,
    'counterparty_name','x','received_on',current_date,'file_name','n.pdf'), encode(convert_to('%PDF-1.4 nochannel','UTF8'),'base64'));
  raise exception 'NG: 受領方法なしが通った';
exception when others then
  if sqlerrm like 'NG:%' then raise; end if;
  raise notice 'OK 受領方法なしの電子取引を拒否: %', sqlerrm;
end $$;
do $$ declare r record; begin
  perform register_received_document(jsonb_build_object('kind','electronic','doc_category','quote','doc_date',current_date,'amount',5000,
    'counterparty_name','見積元','received_on',current_date,'channel','web','file_name','q.pdf'), encode(convert_to('%PDF-1.4 quote','UTF8'),'base64'));
  if (select importance from received_documents where file_name='q.pdf') <> 'general' then raise exception 'NG: 見積書は一般書類'; end if;
  raise notice 'OK 見積書は一般書類として登録';
end $$;

-- スキャナ保存の読取条件
create temp table scan_meta as select jsonb_build_object('kind','scanned','doc_category','receipt','doc_date',current_date-50,'amount',3300,
  'counterparty_name','紙の取引先','received_on',current_date-45,'scanned_on',current_date,'resolution_dpi',300,'color_mode','color',
  'page_count',1,'page_size','A4','file_name','scan1.pdf') as m;
grant select on scan_meta to authenticated;
do $$ declare m jsonb; begin select scan_meta.m into m from scan_meta;
  begin perform register_received_document(m || '{"resolution_dpi":150}', encode(convert_to('%PDF-1.4 s150','UTF8'),'base64'));
    raise exception 'NG: 150dpiが通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 解像度200dpi未満を拒否: %', sqlerrm; end;
  begin perform register_received_document(m || '{"color_mode":"mono"}', encode(convert_to('%PDF-1.4 smono','UTF8'),'base64'));
    raise exception 'NG: 白黒2値が通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 白黒2値を拒否: %', sqlerrm; end;
  begin perform register_received_document(m, encode(convert_to('plain text','UTF8'),'base64'));
    raise exception 'NG: 画像・PDF以外が通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 画像・PDF以外を拒否: %', sqlerrm; end;
  begin perform register_received_document(m || jsonb_build_object('scanned_on', current_date-60), encode(convert_to('%PDF-1.4 sbefore','UTF8'),'base64'));
    raise exception 'NG: 授受日より前の読取日が通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 授受日より前の読取日を拒否: %', sqlerrm; end;
end $$;
select register_received_document((select m from scan_meta), encode(convert_to('%PDF-1.4 scan-ok','UTF8'),'base64')) as s1 \gset
select register_received_document((select m from scan_meta) || jsonb_build_object('received_on', current_date-120, 'doc_date', current_date-125, 'file_name', 'old.pdf'),
  encode(convert_to('%PDF-1.4 scan-old','UTF8'),'base64')) as s2 \gset
select set_config('t.s1', :'s1', false), set_config('t.s2', :'s2', false);
do $$ begin
  if (select input_timeliness from received_documents where id = current_setting('t.s1')::uuid) <> 'cycle' then raise exception 'NG: 45日前受領は cycle'; end if;
  if (select input_timeliness from received_documents where id = current_setting('t.s2')::uuid) <> 'late' then raise exception 'NG: 120日前受領は late'; end if;
  raise notice 'OK スキャン入力の期限判定（7営業日以内=early / 2か月+7営業日以内=cycle / 超過=late）';
end $$;

-- 改ざん防止
do $$ begin
  update received_documents set amount = 1;
  raise exception 'NG: 更新が通った';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 受領書類の更新を拒否: %', sqlerrm; end $$;
do $$ begin
  delete from received_documents;
  raise exception 'NG: 削除が通った';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 受領書類の削除を拒否: %', sqlerrm; end $$;
reset role;
do $$ begin
  update received_documents set data = 'x'::bytea;
  raise exception 'NG: 特権ロールで本体を書換えできた';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 特権ロールでも本体の書換えを拒否: %', sqlerrm; end $$;
set role authenticated;

-- 検索（取引年月日の範囲・金額の範囲・取引先）
do $$ declare n int; begin
  select count(*) into n from received_documents where doc_date >= current_date-20 and amount between 100000 and 120000 and counterparty_name like 'テスト%';
  if n <> 1 then raise exception 'NG: 検索 %', n; end if;
  raise notice 'OK 日付・金額・取引先の組合せ検索';
end $$;

-- タイムスタンプ
do $$ declare t timestamptz := now(); begin
  begin perform record_timestamp('received_documents', current_setting('t.e1')::uuid, 'TSA', t + interval '1 hour', '1', encode(convert_to(repeat('x',32),'UTF8'),'base64'));
    raise exception 'NG: 未来の時刻が通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 未来のタイムスタンプ時刻を拒否: %', sqlerrm; end;
  begin perform record_timestamp('received_documents', current_setting('t.e1')::uuid, 'TSA', t - interval '1 day', '1', encode(convert_to(repeat('x',32),'UTF8'),'base64'));
    raise exception 'NG: 登録より前の時刻が通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 登録より前のタイムスタンプ時刻を拒否: %', sqlerrm; end;
  begin perform record_timestamp('received_documents', current_setting('t.e1')::uuid, 'TSA', t, '1', 'AAAA');
    raise exception 'NG: 短いトークンが通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 不正なトークンを拒否: %', sqlerrm; end;
end $$;
do $$ declare r record; begin
  select status into r from v_timestamp_status where subject_id = current_setting('t.e1')::uuid;
  if r.status <> 'pending' then raise exception 'NG: 付与前は pending のはず %', r.status; end if;
  if (select status from v_timestamp_status where subject_id = current_setting('t.s2')::uuid) <> 'overdue' then raise exception 'NG: 期限超過で未付与は overdue'; end if;
  raise notice 'OK 付与状況: 期限内で未付与=pending / 期限超過で未付与=overdue';
end $$;
select record_timestamp('received_documents', :'e1', 'テストTSA', now(), 'SN-1', encode(convert_to(repeat('t',64),'UTF8'),'base64')) as ts1 \gset
do $$ declare r record; begin
  select * into r from document_timestamps where subject_id = current_setting('t.e1')::uuid;
  if r.sha256 <> (select sha256 from received_documents where id = current_setting('t.e1')::uuid) then raise exception 'NG: 対象のハッシュを控えていない'; end if;
  if (select status from v_timestamp_status where subject_id = current_setting('t.e1')::uuid) <> 'stamped' then raise exception 'NG: 期限内の付与は stamped'; end if;
  raise notice 'OK タイムスタンプを記録（対象のハッシュを控え、期限内は stamped）';
end $$;
do $$ begin
  update document_timestamps set tsa_name = 'x';
  raise exception 'NG: タイムスタンプの更新が通った';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK タイムスタンプは追記のみ: %', sqlerrm; end $$;

-- 取消と再登録
do $$ begin
  perform void_received_document(current_setting('t.e1')::uuid, '  ');
  raise exception 'NG: 理由なしの取消が通った';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 理由なしの取消を拒否: %', sqlerrm; end $$;
select void_received_document(:'e1', '登録ミス');
select register_received_document(jsonb_build_object('kind','electronic','doc_category','invoice','doc_date',current_date-10,'amount',110000,
  'counterparty_name','テスト外注','received_on',current_date-3,'channel','email','file_name','inv1.pdf'),
  encode(convert_to('%PDF-1.4 inv1','UTF8'),'base64'));
do $$ begin
  if (select count(*) from received_documents where voided) <> 1 then raise exception 'NG: 取消の行'; end if;
  raise notice 'OK 取消した書類は残り、同じファイルを登録し直せる';
end $$;

-- 権限
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004', false);
do $$ begin
  perform register_received_document(jsonb_build_object('kind','electronic','doc_category','invoice','doc_date',current_date,'amount',1,
    'counterparty_name','x','received_on',current_date,'channel','email','file_name','v.pdf'), encode(convert_to('%PDF-1.4 viewer','UTF8'),'base64'));
  raise exception 'NG: 閲覧専用が登録できた';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 閲覧専用は登録できない: %', sqlerrm; end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002', false);
select count(*) as stranger_sees_received from received_documents;
