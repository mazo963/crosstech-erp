-- ダウンロードの求めへの出力: 発行済み帳票の「固定した内容」を、ハッシュの計算に使ったそのままの文字列で取り出す
--   content_sha256 = SHA-256(content_text を UTF-8 にしたもの)。画面で照合できる
create view public.v_export_issued_content with (security_invoker = true) as
select d.id, d.doc_type, d.doc_no, d.version, d.doc_date, d.amount, d.counterparty_name,
       d.content::text as content_text, d.content_sha256,
       d.voided, d.void_reason, d.voided_at, d.issued_at
  from public.issued_documents d;
revoke all on public.v_export_issued_content from anon;
