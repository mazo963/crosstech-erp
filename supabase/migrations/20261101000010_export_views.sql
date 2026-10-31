-- =====================================================================
-- ダウンロードの求め（税務調査）への出力用ビュー
--   国税庁 一問一答【電子取引関係】問59: 形式・並び順は問わないが、税務職員が確認可能で、通常出力できる形式であること
--   → 検索項目（取引年月日・取引金額・取引先）を含む一覧と、ファイル本体を、画面からCSV・ZIPで出力する
--   ビューは呼び出したユーザーの権限（RLS）で動く。ファイル本体（bytea）は含めない
-- =====================================================================

-- 受領書類（電子取引・スキャナ保存）
create view public.v_export_received with (security_invoker = true) as
select
  r.id, r.kind, r.doc_category, r.importance,
  r.doc_date, r.amount, r.counterparty_name,
  r.related_ref,
  (select string_agg(coalesce(l.ref, '') || coalesce('[外注仕入 ' || l.purchase_id::text || ']', ''), ' / ' order by l.created_at)
     from public.received_document_links l where l.received_id = r.id) as link_refs,
  r.received_on, r.channel, r.file_name, r.mime_type, r.size_bytes, r.sha256,
  r.scanned_on, r.resolution_dpi, r.color_mode, r.page_size, r.page_count,
  r.deadline_early, r.deadline_max, r.input_timeliness, r.paper_original_required,
  r.registered_on, r.registered_at, s.name as registered_by_name,
  r.voided, r.void_reason, r.voided_at,
  ts.status as timestamp_status, ts.first_gen_time as timestamp_first_time, ts.stamp_count as timestamp_count,
  (select d.tsa_name from public.document_timestamps d
    where d.subject_table = 'received_documents' and d.subject_id = r.id order by d.gen_time limit 1) as timestamp_tsa
from public.received_documents r
left join public.staff s on s.id = r.registered_by
left join public.v_timestamp_status ts on ts.subject_table = 'received_documents' and ts.subject_id = r.id;

-- 発行済み帳票（見積書・納品書・請求書）。交付の記録をまとめて1行にする
create view public.v_export_issued with (security_invoker = true) as
select
  d.id, d.doc_type, d.doc_no, d.version, d.doc_date, d.amount, d.counterparty_name,
  d.content_sha256, d.voided, d.void_reason, d.voided_at, d.issued_at, s.name as issued_by_name,
  (select string_agg(to_char(dv.delivered_on, 'YYYY-MM-DD') || ' ' ||
            case dv.method when 'paper' then '紙' when 'email_pdf' then 'PDF' else 'その他' end ||
            coalesce(' ' || dv.recipient, ''), ' / ' order by dv.delivered_on, dv.created_at)
     from public.document_deliveries dv where dv.document_id = d.id) as deliveries,
  (select count(*) from public.document_files f where f.document_id = d.id) as sent_pdf_count
from public.issued_documents d
left join public.staff s on s.id = d.issued_by;

-- 送付したPDF（電子取引データ）
create view public.v_export_sent_files with (security_invoker = true) as
select
  f.id, f.document_id, d.doc_type, d.doc_no, d.version, d.doc_date, d.amount, d.counterparty_name,
  f.file_name, f.size_bytes, f.sha256, f.uploaded_at,
  dv.delivered_on, dv.method as delivery_method, dv.recipient,
  d.voided,
  ts.status as timestamp_status, ts.first_gen_time as timestamp_first_time, ts.stamp_count as timestamp_count,
  (select x.tsa_name from public.document_timestamps x
    where x.subject_table = 'document_files' and x.subject_id = f.id order by x.gen_time limit 1) as timestamp_tsa
from public.document_files f
join public.issued_documents d on d.id = f.document_id
left join public.document_deliveries dv on dv.id = f.delivery_id
left join public.v_timestamp_status ts on ts.subject_table = 'document_files' and ts.subject_id = f.id;

revoke all on public.v_export_received, public.v_export_issued, public.v_export_sent_files from anon;
