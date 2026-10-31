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

-- 暦の2か月（国税庁 電子取引 問62: 4月21日に受領 → 最長2か月は6月20日。応当日がなければ月末日）
do $$ begin
  if public.calendar_two_months_end('2026-04-21') <> '2026-06-20' then raise exception 'NG: 4/21 → %', public.calendar_two_months_end('2026-04-21'); end if;
  if public.calendar_two_months_end('2026-12-31') <> '2027-02-28' then raise exception 'NG: 12/31 → %', public.calendar_two_months_end('2026-12-31'); end if;
  if public.calendar_two_months_end('2027-12-31') <> '2028-02-29' then raise exception 'NG: うるう年 12/31 → %', public.calendar_two_months_end('2027-12-31'); end if;
  if public.calendar_two_months_end('2026-01-30') <> '2026-03-29' then raise exception 'NG: 1/30 → %', public.calendar_two_months_end('2026-01-30'); end if;
  raise notice 'OK 暦の2か月の計算（応当日の前日、応当日がなければ月末日）';
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
  if r.deadline_early <> public.add_business_days(r.received_on, 7) or r.deadline_max <> public.add_business_days(public.calendar_two_months_end(r.received_on), 7) then raise exception 'NG: 期限'; end if;
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
  'page_count',1,'page_size','A4','file_name','scan1.pdf','related_ref','PUR-001') as m;
grant select on scan_meta to authenticated;
do $$ declare m jsonb; begin select scan_meta.m into m from scan_meta;
  begin perform register_received_document(m || '{"resolution_dpi":150}', encode(convert_to('%PDF-1.4 s150','UTF8'),'base64'));
    raise exception 'NG: 150dpiが通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 解像度200dpi未満を拒否: %', sqlerrm; end;
  begin perform register_received_document(m || '{"color_mode":"grayscale"}', encode(convert_to('%PDF-1.4 sgray','UTF8'),'base64'));
    raise exception 'NG: 重要書類のグレースケールが通った'; exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 重要書類のグレースケールを拒否: %', sqlerrm; end;
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

-- 帳簿との相互関連性: 登録時に帳簿が未作成でも登録でき、未紐づけとして一覧に出る。後から追記で紐づけられる（問21の注）
select register_received_document((select m from scan_meta) - 'related_ref' || jsonb_build_object('file_name','unlinked.pdf'),
  encode(convert_to('%PDF-1.4 unlinked','UTF8'),'base64')) as u1 \gset
select set_config('t.u1', :'u1', false);
do $$ begin
  if not exists (select 1 from v_received_unlinked where id = current_setting('t.u1')::uuid) then raise exception 'NG: 未紐づけの一覧に出ない'; end if;
  insert into received_document_links (received_id, ref) values (current_setting('t.u1')::uuid, 'PUR-777');
  if exists (select 1 from v_received_unlinked where id = current_setting('t.u1')::uuid) then raise exception 'NG: 紐づけ後も未紐づけに残る'; end if;
  begin update received_document_links set ref = 'x'; raise exception 'NG: 紐づけの更新が通った';
  exception when others then if sqlerrm like 'NG:%' then raise; end if; end;
  begin insert into received_document_links (received_id) values (current_setting('t.u1')::uuid); raise exception 'NG: 空の紐づけが通った';
  exception when others then if sqlerrm like 'NG:%' then raise; end if; end;
  raise notice 'OK 重要書類は後から帳簿へ紐づけでき（追記のみ）、未紐づけは一覧に出る';
end $$;

-- 一般書類（見積書）はグレースケール可・関連帳簿は不要。入力期間を過ぎた重要書類は紙の原本の保存が必要（スキャナ保存 問24）
select register_received_document((select m from scan_meta) || jsonb_build_object('doc_category','quote','color_mode','grayscale','file_name','gq.pdf') - 'related_ref',
  encode(convert_to('%PDF-1.4 gen-gray','UTF8'),'base64')) as g1 \gset
select register_received_document((select m from scan_meta) || jsonb_build_object('doc_category','quote','color_mode','grayscale','received_on',current_date-120,'doc_date',current_date-125,'file_name','gq2.pdf') - 'related_ref',
  encode(convert_to('%PDF-1.4 gen-gray-old','UTF8'),'base64')) as g2 \gset
select set_config('t.g1', :'g1', false), set_config('t.g2', :'g2', false);
do $$ begin
  if (select importance from received_documents where id = current_setting('t.g1')::uuid) <> 'general' then raise exception 'NG: 見積書は一般書類'; end if;
  if (select paper_original_required from received_documents where id = current_setting('t.s2')::uuid) is not true then raise exception 'NG: 期限を過ぎた重要書類は紙の原本が必要'; end if;
  if (select paper_original_required from received_documents where id = current_setting('t.s1')::uuid) is not false then raise exception 'NG: 期限内の重要書類は紙の原本は不要'; end if;
  if (select paper_original_required from received_documents where id = current_setting('t.g2')::uuid) is not false then raise exception 'NG: 一般書類は入力期間の制限なし'; end if;
  raise notice 'OK 一般書類はグレースケール可・関連帳簿は不要・入力期間の制限なし。期限を過ぎた重要書類は「紙の原本を保存」';
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

-- ダウンロードの求め用の出力ビュー（ファイル本体は含まない。タイムスタンプの状況・取消も出る）
do $$ declare r record; begin
  select * into r from v_export_received where id = current_setting('t.e1')::uuid;
  if r.counterparty_name <> 'テスト外注' or r.amount <> 110000 or r.timestamp_status <> 'stamped' or r.timestamp_tsa <> 'テストTSA' or r.sha256 is null then
    raise exception 'NG: 出力ビュー %', to_jsonb(r); end if;
  if (select count(*) from v_export_received where kind = 'scanned' and importance = 'important' and paper_original_required) < 1 then raise exception 'NG: 紙の原本保存の出力'; end if;
  if (select link_refs from v_export_received where id = current_setting('t.u1')::uuid) <> 'PUR-777' then raise exception 'NG: 紐づけの出力'; end if;
  raise notice 'OK 受領書類の出力ビュー（検索項目・ハッシュ・タイムスタンプ・紙の原本保存・紐づけ）';
end $$;

-- 取消と再登録
do $$ begin
  perform void_received_document(current_setting('t.e1')::uuid, '  ');
  raise exception 'NG: 理由なしの取消が通った';
exception when others then if sqlerrm like 'NG:%' then raise; end if; raise notice 'OK 理由なしの取消を拒否: %', sqlerrm; end $$;
select void_received_document(:'e1', '登録ミス');
do $$ begin
  if (select voided from v_export_received where id = current_setting('t.e1')::uuid) is not true then raise exception 'NG: 取消の出力'; end if;
  raise notice 'OK 取消した書類も出力に含まれる（取消の有無・理由つき）';
end $$;
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
