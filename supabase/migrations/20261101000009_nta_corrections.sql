-- =====================================================================
-- 国税庁の一次資料（電子帳簿保存法一問一答 令和8年7月、スキャナ保存・電子取引の各分冊ほか）に基づく修正
--   * 「2か月」は暦の2か月（応当日の前日。応当日がなければ月末日）。電子取引 問62（4/21受領 → 6/20）
--   * スキャナ保存: 重要書類はカラー（24ビット）で読み取る。グレースケールは一般書類のみ（スキャナ保存 問10）
--   * スキャナ保存: 帳簿との相互関連性は重要書類で必要（同 問10）。ただし登録時に帳簿が未作成なら、決算終了後遅滞なく満たせばよい（同 問21の注）
--     → 登録時は必須にせず、未紐づけを一覧で示し、後から追記のみで紐づける
--   * スキャナ保存: 入力期間を過ぎた重要書類は、電子データで紙の保存に代えられず、紙のまま保存する（同 問24）
--   * 税区分: 軽減税率の「飲食料品」と「新聞の定期購読」を分ける（令和9年4月1日以後、税率が分かれる予定のため）
-- =====================================================================

-- 暦の2か月の最終日: 応当日があればその前日、なければその月の末日
create function public.calendar_two_months_end(p_date date)
returns date language plpgsql immutable as $$
declare v date := (p_date + interval '2 months')::date;
begin
  if extract(day from v) = extract(day from p_date) then return v - 1; end if;
  return v;
end $$;
revoke execute on function public.calendar_two_months_end(date) from public, anon;
grant  execute on function public.calendar_two_months_end(date) to authenticated;

-- 入力期間を過ぎた重要書類のスキャナ保存は、紙の原本を保存し続ける必要がある
alter table public.received_documents add column paper_original_required boolean not null default false;
alter table public.received_documents disable trigger trg_received_documents_guard;
update public.received_documents
   set deadline_max = public.add_business_days(public.calendar_two_months_end(received_on), 7),
       input_timeliness = case when coalesce(scanned_on, registered_on) <= deadline_early then 'early'
                               when coalesce(scanned_on, registered_on) <= public.add_business_days(public.calendar_two_months_end(received_on), 7) then 'cycle'
                               else 'late' end;
update public.received_documents set paper_original_required = (kind = 'scanned' and importance = 'important' and input_timeliness = 'late');
alter table public.received_documents enable trigger trg_received_documents_guard;

create or replace function public.register_received_document(p_meta jsonb, p_base64 text)
returns uuid language plpgsql as $$
declare
  v_data    bytea := decode(p_base64, 'base64');
  v_kind    text := p_meta->>'kind';
  v_cat     text := p_meta->>'doc_category';
  v_imp     text := case when p_meta->>'doc_category' in ('quote','order') then 'general' else 'important' end;
  v_recv    date := (p_meta->>'received_on')::date;
  v_today   date := (now() at time zone 'Asia/Tokyo')::date;
  v_input   date;
  v_early   date;
  v_max     date;
  v_magic   bytea;
  v_hash    text;
  v_timely  text;
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
    -- スキャナ保存の読取条件（国税庁 一問一答【スキャナ保存関係】問10）
    --   解像度200dpi以上。重要書類はカラー（赤・緑・青 各256階調以上）、一般書類はグレースケールも可
    if coalesce((p_meta->>'resolution_dpi')::int, 0) < 200 then raise exception '解像度は200dpi以上で読み取ってください'; end if;
    if v_imp = 'important' and coalesce(p_meta->>'color_mode', '') <> 'color' then
      raise exception '重要書類（契約書・納品書・請求書・領収書など）はカラーで読み取ってください（グレースケールは見積書・注文書などの一般書類のみ）';
    end if;
    if v_imp = 'general' and coalesce(p_meta->>'color_mode', '') not in ('color', 'grayscale') then
      raise exception 'カラーまたはグレースケールで読み取ってください（白黒2値は不可）';
    end if;
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
  v_max   := public.add_business_days(public.calendar_two_months_end(v_recv), 7);
  v_timely := case when v_input <= v_early then 'early' when v_input <= v_max then 'cycle' else 'late' end;

  insert into public.received_documents (kind, doc_category, importance, doc_date, amount, counterparty_name, vendor_id, purchase_id, related_ref,
      received_on, channel, file_name, mime_type, size_bytes, sha256, data, scanned_on, resolution_dpi, color_mode, page_size, page_count,
      deadline_early, deadline_max, input_timeliness, paper_original_required, registered_on)
  values (v_kind, v_cat, v_imp,
      (p_meta->>'doc_date')::date, (p_meta->>'amount')::numeric, btrim(p_meta->>'counterparty_name'),
      nullif(p_meta->>'vendor_id', '')::uuid, nullif(p_meta->>'purchase_id', '')::uuid, nullif(btrim(p_meta->>'related_ref'), ''),
      v_recv, nullif(p_meta->>'channel', ''), p_meta->>'file_name', nullif(p_meta->>'mime_type', ''), length(v_data), v_hash, v_data,
      case when v_kind = 'scanned' then v_input end, case when v_kind = 'scanned' then (p_meta->>'resolution_dpi')::int end,
      case when v_kind = 'scanned' then p_meta->>'color_mode' end, nullif(p_meta->>'page_size', ''),
      case when v_kind = 'scanned' then (p_meta->>'page_count')::int end,
      v_early, v_max, v_timely, (v_kind = 'scanned' and v_imp = 'important' and v_timely = 'late'), v_today)
  returning id into v_id;
  return v_id;
end $$;

-- タイムスタンプの付与期限（暦の2か月 + 7営業日）
create or replace view public.v_timestamp_status with (security_invoker = true) as
with subjects as (
  select 'received_documents'::text as subject_table, r.id as subject_id,
         r.counterparty_name || ' ' || r.file_name as label, r.registered_at as since, r.deadline_max as deadline, r.voided
    from public.received_documents r
  union all
  select 'document_files', f.id, d.doc_no || ' ' || f.file_name, f.uploaded_at,
         public.add_business_days(public.calendar_two_months_end(coalesce(dv.delivered_on, (f.uploaded_at at time zone 'Asia/Tokyo')::date)), 7),
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

-- 税区分: 「軽減税率」は飲食料品。新聞の定期購読は別の区分（令和9年4月1日以後、税率が分かれる予定）
update public.tax_categories set name = '軽減税率（飲食料品）' where code = 'reduced';
insert into public.tax_categories (code, name, is_reduced, sort_order) values ('newspaper', '軽減税率（新聞の定期購読）', true, 3);
insert into public.tax_rate_periods (category_code, rate, valid_from) values ('newspaper', 0.08, date '2019-10-01');
-- 区分の名称・有効/無効は管理者が変更できる（税率そのものは set_tax_rate 経由）
grant update (name, active) on public.tax_categories to authenticated;
create policy tax_categories_update on public.tax_categories for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 帳簿との相互関連性（重要書類）: 登録後に紐づけを追記できる。追記のみ（更新・削除不可）
-- ---------------------------------------------------------------------
create table public.received_document_links (
  id          uuid primary key default gen_random_uuid(),
  received_id uuid not null references public.received_documents(id),
  purchase_id uuid references public.purchases(id),
  ref         text,                                  -- 関連する帳簿の伝票番号など
  created_by  uuid references public.staff(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  check (purchase_id is not null or coalesce(btrim(ref), '') <> '')
);
create index on public.received_document_links (received_id);
create trigger trg_received_document_links_append_only before update or delete on public.received_document_links
  for each row execute function public.tg_append_only();
alter table public.received_document_links enable row level security;
revoke all on public.received_document_links from anon;
revoke update, delete, truncate on public.received_document_links from authenticated;
create policy received_document_links_select on public.received_document_links for select to authenticated using (public.is_staff());
create policy received_document_links_insert on public.received_document_links for insert to authenticated with check (public.can_write());

-- 重要書類のスキャナ保存で、帳簿への紐づけがまだないもの
create view public.v_received_unlinked with (security_invoker = true) as
select r.id, r.doc_date, r.counterparty_name, r.amount, r.file_name, r.registered_on
  from public.received_documents r
 where r.kind = 'scanned' and r.importance = 'important' and not r.voided
   and r.purchase_id is null and coalesce(btrim(r.related_ref), '') = ''
   and not exists (select 1 from public.received_document_links l where l.received_id = r.id);
