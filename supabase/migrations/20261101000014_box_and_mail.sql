-- =====================================================================
-- 送付の流れ（PDFを作る → お客様へメール → Box へも保存）に必要な設定と記録
--   * company_settings.box_import_email : MF クラウドBox の「メール取込」用アドレス
--       （Box は、宛先に複数のアドレスが含まれるメールを保存できないため、お客様宛とは別のメールで送る）
--   * company_settings.mail_signature   : メール本文の署名
--   * company_settings.own_timestamp    : ERP自身でタイムスタンプを付与するか。false（既定）= Box等の外部サービスに任せる。
--       false のとき、付与の状況は「自社では付与しない」と表示し、期限超過の警告を出さない
--   * 交付の方法に「Box保存」を追加する
-- =====================================================================
alter table public.company_settings
  add column box_import_email text,
  add column mail_signature   text,
  add column own_timestamp    boolean not null default false;

alter table public.document_deliveries drop constraint document_deliveries_method_check;
alter table public.document_deliveries add constraint document_deliveries_method_check
  check (method in ('paper','email_pdf','box','other'));

-- 付与の状況: 自社で付与しない設定のとき、未付与のものは 'external'（警告しない）
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
         when not coalesce((select own_timestamp from public.company_settings where id = 1), false) then 'external'
         when s.deadline < (now() at time zone 'Asia/Tokyo')::date then 'overdue'
         else 'pending'
       end as status
from subjects s
left join lateral (
  select min(gen_time) as first_gen_time, count(*) as stamp_count
    from public.document_timestamps x where x.subject_table = s.subject_table and x.subject_id = s.subject_id
) t on true;

-- 出力用ビュー: 交付の記録に「Box保存」を表示
create or replace view public.v_export_issued with (security_invoker = true) as
select
  d.id, d.doc_type, d.doc_no, d.version, d.doc_date, d.amount, d.counterparty_name,
  d.content_sha256, d.voided, d.void_reason, d.voided_at, d.issued_at, s.name as issued_by_name,
  (select string_agg(to_char(dv.delivered_on, 'YYYY-MM-DD') || ' ' ||
            case dv.method when 'paper' then '紙' when 'email_pdf' then 'PDF' when 'box' then 'Box保存' else 'その他' end ||
            coalesce(' ' || dv.recipient, ''), ' / ' order by dv.delivered_on, dv.created_at)
     from public.document_deliveries dv where dv.document_id = d.id) as deliveries,
  (select count(*) from public.document_files f where f.document_id = d.id) as sent_pdf_count
from public.issued_documents d
left join public.staff s on s.id = d.issued_by;
