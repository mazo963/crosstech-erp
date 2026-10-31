-- =====================================================================
-- 受領した書類の保存（電子取引データ保存 / スキャナ保存）とタイムスタンプ
--   * 電子取引: メール・Web・EDI等で受け取った請求書・領収書などを、電子データのまま保存する
--   * スキャナ保存: 紙で受け取った書類を読み取って保存する（読取の条件を記録し、満たさないものは登録できない）
--   * どちらも取引年月日・取引金額・取引先で検索でき、登録後は更新・削除ができない（誤りは取消して登録し直す）
--   * タイムスタンプ: 付与の記録（RFC 3161のトークン）を追記のみで持ち、期限内に付与されたかを一覧で確認できる
--   法令上の数値・期限は docs/電帳法対応方針.md の「要確認」を参照。ここでの値は保守的な（厳しい側の）設定
-- =====================================================================

-- 営業日の加算（土日のみ除く。祝日は考慮しない = 期限が早めに出る保守的な計算）
create function public.add_business_days(p_date date, p_days integer)
returns date language plpgsql immutable as $$
declare v date := p_date; n integer := 0;
begin
  while n < p_days loop
    v := v + 1;
    if extract(isodow from v) < 6 then n := n + 1; end if;
  end loop;
  return v;
end $$;

create table public.received_documents (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('electronic','scanned')),
  doc_category     text not null check (doc_category in ('invoice','receipt','delivery_note','quote','order','contract','other')),
  importance       text not null check (importance in ('important','general')),
  doc_date         date not null,                       -- 取引年月日
  amount           numeric(14,0) not null,              -- 取引金額（書類に記載の合計。税込）
  counterparty_name text not null,                      -- 取引先
  vendor_id        uuid references public.vendors(id),
  purchase_id      uuid references public.purchases(id),-- 帳簿（外注仕入）との相互関連性
  related_ref      text,                                -- 関連する伝票番号・メモ
  received_on      date not null,                       -- 授受日（受け取った日）
  channel          text check (channel in ('email','web','edi','cloud','post','hand','other')),
  file_name        text not null,
  mime_type        text,
  size_bytes       integer not null,
  sha256           text not null,
  data             bytea not null,
  -- スキャナ保存の読取条件
  scanned_on       date,
  resolution_dpi   integer,
  color_mode       text check (color_mode in ('color','grayscale','mono')),
  page_size        text,
  page_count       integer,
  -- 入力期限（営業日は土日のみ除外）
  deadline_early   date not null,                       -- 授受日から7営業日
  deadline_max     date not null,                       -- 授受日の2か月後から7営業日
  input_timeliness text not null check (input_timeliness in ('early','cycle','late')),
  registered_on    date not null,                       -- 登録日（日本時間）
  registered_at    timestamptz not null default now(),
  registered_by    uuid references public.staff(id) default auth.uid(),
  voided           boolean not null default false,
  void_reason      text,
  voided_at        timestamptz,
  voided_by        uuid references public.staff(id),
  constraint received_scan_chk check (
    (kind = 'electronic' and scanned_on is null and resolution_dpi is null and color_mode is null and page_count is null)
    or (kind = 'scanned' and scanned_on is not null and resolution_dpi is not null and color_mode is not null and page_count >= 1)),
  constraint received_void_chk check (not voided or coalesce(btrim(void_reason), '') <> '')
);
create index on public.received_documents (doc_date);
create index on public.received_documents (amount);
create index on public.received_documents (counterparty_name);
create unique index received_documents_sha256_uq on public.received_documents (sha256) where not voided;

-- 登録後は内容を変更できない。削除もできない。取消は false → true のみ
create function public.tg_received_documents_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '受領書類は削除できません（取消してください）';
  end if;
  if (to_jsonb(new) - array['voided','void_reason','voided_at','voided_by']) <> (to_jsonb(old) - array['voided','void_reason','voided_at','voided_by']) then
    raise exception '登録済みの受領書類の内容は変更できません（取消して登録し直してください）';
  end if;
  if old.voided and not new.voided then raise exception '取消した受領書類は元に戻せません'; end if;
  return new;
end $$;
create trigger trg_received_documents_guard before update or delete on public.received_documents
  for each row execute function public.tg_received_documents_guard();
-- 監査ログ（audit_log）には入れない: ファイル本体（bytea）を含むため。登録後は変更できないので、行そのものが履歴になる

-- 書類の登録（電子取引・スキャナ保存の両方）。ハッシュ・期限・重要書類/一般書類の区分はDBが決める
--   p_meta: kind, doc_category, doc_date, amount, counterparty_name, vendor_id, purchase_id, related_ref, received_on,
--           channel, file_name, mime_type, scanned_on, resolution_dpi, color_mode, page_size, page_count
create function public.register_received_document(p_meta jsonb, p_base64 text)
returns uuid language plpgsql as $$
declare
  v_data    bytea := decode(p_base64, 'base64');
  v_kind    text := p_meta->>'kind';
  v_cat     text := p_meta->>'doc_category';
  v_recv    date := (p_meta->>'received_on')::date;
  v_today   date := (now() at time zone 'Asia/Tokyo')::date;
  v_input   date;
  v_early   date;
  v_max     date;
  v_magic   bytea;
  v_hash    text;
  v_id      uuid;
begin
  if length(v_data) = 0 or length(v_data) > 10 * 1024 * 1024 then raise exception 'ファイルのサイズが不正です（10MBまで）'; end if;
  if coalesce(btrim(p_meta->>'counterparty_name'), '') = '' then raise exception '取引先を入力してください'; end if;
  if p_meta->>'amount' is null then raise exception '取引金額を入力してください'; end if;
  if p_meta->>'doc_date' is null or v_recv is null then raise exception '取引年月日と授受日を入力してください'; end if;
  if v_recv > v_today then raise exception '授受日が未来の日付です'; end if;

  v_hash := encode(sha256(v_data), 'hex');
  if exists (select 1 from public.received_documents where sha256 = v_hash and not voided) then
    raise exception '同じファイルがすでに登録されています';
  end if;

  if v_kind = 'electronic' then
    if coalesce(p_meta->>'channel', '') = '' then raise exception '受け取った方法（メール・Web等）を選択してください'; end if;
    v_input := v_today;
  elsif v_kind = 'scanned' then
    -- スキャナ保存の読取条件（保守的な設定。要確認）: 解像度200dpi以上、カラーまたはグレースケール、ページ数、PDF/画像
    if coalesce((p_meta->>'resolution_dpi')::int, 0) < 200 then raise exception '解像度は200dpi以上で読み取ってください'; end if;
    if coalesce(p_meta->>'color_mode', '') not in ('color', 'grayscale') then raise exception 'カラーまたはグレースケールで読み取ってください（白黒2値は不可）'; end if;
    if coalesce((p_meta->>'page_count')::int, 0) < 1 then raise exception 'ページ数を入力してください'; end if;
    v_input := (p_meta->>'scanned_on')::date;
    if v_input is null then raise exception '読み取った日を入力してください'; end if;
    if v_input > v_today or v_input < v_recv then raise exception '読取日が授受日より前、または未来の日付です'; end if;
    v_magic := substring(v_data from 1 for 4);
    if not (v_magic = '\x25504446'::bytea or v_magic = '\x89504e47'::bytea or substring(v_magic from 1 for 3) = '\xffd8ff'::bytea
            or v_magic = '\x49492a00'::bytea or v_magic = '\x4d4d002a'::bytea) then
      raise exception '読み取ったファイルはPDF・PNG・JPEG・TIFFのいずれかにしてください';
    end if;
  else
    raise exception '登録の種類が不正です';
  end if;

  v_early := public.add_business_days(v_recv, 7);
  v_max   := public.add_business_days((v_recv + interval '2 months')::date, 7);

  insert into public.received_documents (kind, doc_category, importance, doc_date, amount, counterparty_name, vendor_id, purchase_id, related_ref,
      received_on, channel, file_name, mime_type, size_bytes, sha256, data, scanned_on, resolution_dpi, color_mode, page_size, page_count,
      deadline_early, deadline_max, input_timeliness, registered_on)
  values (v_kind, v_cat, case when v_cat in ('quote','order') then 'general' else 'important' end,
      (p_meta->>'doc_date')::date, (p_meta->>'amount')::numeric, btrim(p_meta->>'counterparty_name'),
      nullif(p_meta->>'vendor_id', '')::uuid, nullif(p_meta->>'purchase_id', '')::uuid, nullif(btrim(p_meta->>'related_ref'), ''),
      v_recv, nullif(p_meta->>'channel', ''), p_meta->>'file_name', nullif(p_meta->>'mime_type', ''), length(v_data), v_hash, v_data,
      case when v_kind = 'scanned' then v_input end, case when v_kind = 'scanned' then (p_meta->>'resolution_dpi')::int end,
      case when v_kind = 'scanned' then p_meta->>'color_mode' end, nullif(p_meta->>'page_size', ''),
      case when v_kind = 'scanned' then (p_meta->>'page_count')::int end,
      v_early, v_max, case when v_input <= v_early then 'early' when v_input <= v_max then 'cycle' else 'late' end, v_today)
  returning id into v_id;
  return v_id;
end $$;

create function public.received_file_base64(p_id uuid)
returns text language sql stable as $$ select encode(data, 'base64') from public.received_documents where id = p_id $$;

-- 取消（理由必須）。更新権限は持たせず、この関数だけが取消の列を更新する
create function public.void_received_document(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_write() then raise exception '取消の権限がありません'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception '取消理由を入力してください'; end if;
  update public.received_documents set voided = true, void_reason = btrim(p_reason), voided_at = now(), voided_by = auth.uid()
   where id = p_id and not voided;
  if not found then raise exception '受領書類が見つからないか、すでに取消済みです'; end if;
end $$;

-- ---------------------------------------------------------------------
-- タイムスタンプ（RFC 3161）の記録。追記のみ。付与そのものはEdge Function（timestamp）が行う
-- ---------------------------------------------------------------------
create table public.document_timestamps (
  id             uuid primary key default gen_random_uuid(),
  subject_table  text not null check (subject_table in ('received_documents','document_files','issued_documents')),
  subject_id     uuid not null,
  sha256         text not null,                -- 付与対象のハッシュ（対象の行のハッシュと一致していること）
  tsa_name       text not null,                -- 時刻認証局（TSA）の名称
  gen_time       timestamptz not null,         -- トークンに記載の時刻
  serial         text,
  token          bytea not null,               -- TimeStampToken（DER）。検証は scripts/verify_timestamp.sh
  created_by     uuid references public.staff(id) default auth.uid(),
  created_at     timestamptz not null default now()
);
create index on public.document_timestamps (subject_table, subject_id);
create trigger trg_document_timestamps_append_only before update or delete on public.document_timestamps
  for each row execute function public.tg_append_only();

-- 対象のハッシュと登録時刻（DBが正）
create function public.timestamp_subject(p_table text, p_id uuid, out o_sha256 text, out o_since timestamptz)
language plpgsql stable as $$
begin
  if p_table = 'received_documents' then
    select sha256, registered_at into o_sha256, o_since from public.received_documents where id = p_id;
  elsif p_table = 'document_files' then
    select sha256, uploaded_at into o_sha256, o_since from public.document_files where id = p_id;
  elsif p_table = 'issued_documents' then
    select content_sha256, issued_at into o_sha256, o_since from public.issued_documents where id = p_id;
  end if;
  if o_sha256 is null then raise exception '付与対象が見つかりません'; end if;
end $$;

create function public.record_timestamp(p_table text, p_id uuid, p_tsa_name text, p_gen_time timestamptz, p_serial text, p_token_b64 text)
returns uuid language plpgsql as $$
declare
  v_sub record;
  v_token bytea := decode(p_token_b64, 'base64');
  v_id uuid;
begin
  select * into v_sub from public.timestamp_subject(p_table, p_id);
  if length(v_token) < 16 then raise exception 'タイムスタンプのトークンが不正です'; end if;
  if p_gen_time > now() + interval '5 minutes' then raise exception 'タイムスタンプの時刻が未来です'; end if;
  if p_gen_time < v_sub.o_since - interval '5 minutes' then raise exception 'タイムスタンプの時刻が、対象の登録より前です'; end if;
  insert into public.document_timestamps (subject_table, subject_id, sha256, tsa_name, gen_time, serial, token)
  values (p_table, p_id, v_sub.o_sha256, p_tsa_name, p_gen_time, p_serial, v_token) returning id into v_id;
  return v_id;
end $$;

create function public.timestamp_token_base64(p_id uuid)
returns text language sql stable as $$ select encode(token, 'base64') from public.document_timestamps where id = p_id $$;

-- 付与状況（受領書類 + 送付したPDF）。期限 = 授受日（送付日）の2か月後から7営業日。付与時刻が日本時間でこの日まで
create view public.v_timestamp_status with (security_invoker = true) as
with subjects as (
  select 'received_documents'::text as subject_table, r.id as subject_id,
         r.counterparty_name || ' ' || r.file_name as label, r.registered_at as since, r.deadline_max as deadline, r.voided
    from public.received_documents r
  union all
  select 'document_files', f.id, d.doc_no || ' ' || f.file_name, f.uploaded_at,
         public.add_business_days((coalesce(dv.delivered_on, (f.uploaded_at at time zone 'Asia/Tokyo')::date) + interval '2 months')::date, 7),
         d.voided
    from public.document_files f
    join public.issued_documents d on d.id = f.document_id
    left join public.document_deliveries dv on dv.id = f.delivery_id
)
select s.subject_table, s.subject_id, s.label, s.since, s.deadline, s.voided,
       t.first_gen_time, t.stamp_count,
       case
         when t.first_gen_time is not null and (t.first_gen_time at time zone 'Asia/Tokyo')::date <= s.deadline then 'stamped'
         when t.first_gen_time is not null then 'stamped_late'
         when s.deadline < (now() at time zone 'Asia/Tokyo')::date then 'overdue'
         else 'pending'
       end as status
from subjects s
left join lateral (
  select min(gen_time) as first_gen_time, count(*) as stamp_count
    from public.document_timestamps x where x.subject_table = s.subject_table and x.subject_id = s.subject_id
) t on true;

-- RLS: 閲覧はスタッフ全員、登録は admin / office。更新・削除のポリシーは作らない
do $$
declare t text;
begin
  foreach t in array array['received_documents','document_timestamps'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke update, delete, truncate on public.%I from authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_write())', t || '_insert', t);
  end loop;
end $$;

revoke execute on function public.register_received_document(jsonb, text), public.received_file_base64(uuid),
  public.void_received_document(uuid, text), public.timestamp_subject(text, uuid),
  public.record_timestamp(text, uuid, text, timestamptz, text, text), public.timestamp_token_base64(uuid),
  public.add_business_days(date, integer) from public, anon;
grant execute on function public.register_received_document(jsonb, text), public.received_file_base64(uuid),
  public.void_received_document(uuid, text), public.timestamp_subject(text, uuid),
  public.record_timestamp(text, uuid, text, timestamptz, text, text), public.timestamp_token_base64(uuid),
  public.add_business_days(date, integer) to authenticated;
