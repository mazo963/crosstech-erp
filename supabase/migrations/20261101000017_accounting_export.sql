-- =====================================================================
-- 税理士へ渡す会計データ（売上・入金）の出力用ビュー
--   * 特定の会計ソフトの形式にはしない（弥生会計の取込形式は、税理士から見本を入手してから別に作る）
--   * 売上: 請求書 × 税率ごとに1行（消費税は請求書1枚・税率ごとに1回の端数処理の結果。再計算しない）
--     下書きは含めない。取消済みは status = 'void' で含める（出力画面で除外できる）
--   * 入金: 1入金1行。消込先の請求書番号を添える。取消済みは voided = true で含める
--   * 金額はDBに保存された値をそのまま出す（画面側で計算しない）
-- =====================================================================
create view public.v_acct_sales with (security_invoker = true) as
select
  i.id as invoice_id, i.invoice_no, i.issue_date, i.status, i.kind,
  c.code as customer_code, c.name as customer_name, c.invoice_reg_no as customer_invoice_reg_no,
  i.period_from, i.period_to, i.due_date,
  t.tax_rate, t.is_reduced, t.taxable_amount, t.tax_amount, t.taxable_amount + t.tax_amount as gross_amount,
  i.subtotal as invoice_subtotal, i.tax as invoice_tax, i.total as invoice_total,
  i.mf_invoice_no,
  (select f.file_name
     from public.issued_documents d join public.document_files f on f.document_id = d.id
    where d.doc_type = 'invoice' and d.source_id = i.id and not d.voided
    order by d.version desc, f.uploaded_at desc limit 1) as sent_pdf_file_name
from public.invoices i
join public.customers c on c.id = i.customer_id
join public.invoice_tax_summary t on t.invoice_id = i.id
where i.status in ('issued', 'void');

create view public.v_acct_payments with (security_invoker = true) as
select
  p.id as payment_id, p.received_on, c.code as customer_code, c.name as customer_name,
  p.amount, p.fee, p.amount + p.fee as cleared_amount, p.method, p.bank_name, p.account_no, p.memo,
  (select string_agg(inv.invoice_no || '（' || a.amount::bigint || '円）', ' / ' order by inv.invoice_no)
     from public.payment_allocations a join public.invoices inv on inv.id = a.invoice_id
    where a.payment_id = p.id) as allocated_invoices,
  p.voided, p.void_reason
from public.payments p
join public.customers c on c.id = p.customer_id;

revoke all on public.v_acct_sales, public.v_acct_payments from anon;
