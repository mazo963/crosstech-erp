-- =====================================================================
-- 帳票の発行イメージ（プレビュー）
--   build_document_content : 帳票の記載内容を組み立てる（金額・消費税の計算はここ＝DB）。発行（issue_document）とプレビューで共通
--   preview_document       : 発行せずに、いま発行したらこうなる、という内容を返す（保存しない）。請求書は下書きも可
--   issue_document         : 従来どおり。組み立ては build_document_content に任せ、固定・版管理だけを行う
--   同じデータなら、プレビューと発行の内容（jsonb）は一致する
-- =====================================================================

create function public.build_document_content(p_type text, p_source_id uuid, p_allow_draft boolean default false)
returns jsonb language plpgsql stable as $$
declare
  v_set     public.company_settings;
  v_cust    public.customers;
  v_proj    public.projects;
  v_dv      public.deliveries;
  v_inv     public.invoices;
  v_no      text;
  v_date    date;
  v_sub     numeric;
  v_tax     numeric;
  v_lines   jsonb;
  v_brk     jsonb;
  v_head    jsonb;
  v_content jsonb;
begin
  select * into v_set from public.company_settings where id = 1;
  v_head := jsonb_build_object(
    'issuer', jsonb_build_object('company_name', v_set.company_name, 'invoice_reg_no', v_set.invoice_reg_no,
      'postal_code', v_set.postal_code, 'address', v_set.address, 'tel', v_set.tel, 'email', v_set.email),
    'doc_type', p_type);

  if p_type = 'quote' then
    select * into v_proj from public.projects where id = p_source_id;
    if not found then raise exception '案件が見つかりません'; end if;
    select * into v_cust from public.customers where id = v_proj.customer_id;
    v_date := coalesce(v_proj.estimate_date, current_date);
    select jsonb_agg(jsonb_build_object('product_no', product_no, 'name', name, 'spec', spec, 'quantity', quantity, 'unit', unit,
             'unit_price', sale_unit_price, 'amount', amt, 'due_date', due_date, 'tax_rate', rate, 'is_reduced', red) order by line_no),
           coalesce(sum(amt), 0)
      into v_lines, v_sub
      from (select i.*, floor(i.quantity * i.sale_unit_price) as amt, public.tax_rate_on(i.tax_category, v_date) as rate, c.is_reduced as red
              from public.project_items i join public.tax_categories c on c.code = i.tax_category
             where i.project_id = p_source_id) l;
    if v_lines is null then raise exception '品目がありません'; end if;
    select jsonb_agg(jsonb_build_object('rate', rate, 'reduced', red, 'base', base,
                      'tax', public.round_tax(base * rate, v_set.tax_rounding)) order by rate desc),
           coalesce(sum(public.round_tax(base * rate, v_set.tax_rounding)), 0)
      into v_brk, v_tax
      from (select public.tax_rate_on(i.tax_category, v_date) as rate, bool_or(c.is_reduced) as red,
                   sum(floor(i.quantity * i.sale_unit_price)) as base
              from public.project_items i join public.tax_categories c on c.code = i.tax_category
             where i.project_id = p_source_id group by 1) g;
    v_no := v_proj.project_no;
    v_content := v_head || jsonb_build_object('title', v_proj.title, 'notes', v_proj.notes, 'due_date', v_proj.due_date,
      'lines', v_lines, 'subtotal', v_sub, 'tax_breakdown', v_brk, 'tax', v_tax, 'total', v_sub + v_tax);

  elsif p_type = 'delivery_note' then
    select * into v_dv from public.deliveries where id = p_source_id;
    if not found then raise exception '納品が見つかりません'; end if;
    if v_dv.voided then raise exception '取消された納品の納品書は発行できません'; end if;
    select c.* into v_cust from public.projects p join public.customers c on c.id = p.customer_id where p.id = v_dv.project_id;
    select jsonb_agg(jsonb_build_object('product_no', i.product_no, 'name', i.name, 'spec', i.spec, 'quantity', dl.quantity,
             'unit', i.unit, 'unit_price', dl.unit_price, 'amount', dl.amount, 'tax_rate', dl.tax_rate, 'is_reduced', dl.is_reduced)
             order by i.line_no),
           coalesce(sum(dl.amount), 0)
      into v_lines, v_sub from public.delivery_lines dl join public.project_items i on i.id = dl.project_item_id
     where dl.delivery_id = p_source_id;
    v_no := v_dv.delivery_no; v_date := v_dv.delivered_on;
    v_content := v_head || jsonb_build_object('project_no', (select project_no from public.projects where id = v_dv.project_id),
      'title', (select title from public.projects where id = v_dv.project_id),
      'customer_po_no', (select customer_po_no from public.projects where id = v_dv.project_id),
      'notes', v_dv.notes, 'lines', v_lines, 'subtotal', v_sub);

  elsif p_type = 'invoice' then
    select * into v_inv from public.invoices where id = p_source_id;
    if not found then raise exception '請求書が見つかりません'; end if;
    if v_inv.status = 'void' then raise exception '取消された請求書の帳票は作れません'; end if;
    if v_inv.status <> 'issued' and not (p_allow_draft and v_inv.status = 'draft') then
      raise exception '発行済みの請求書だけ帳票を発行できます';
    end if;
    select * into v_cust from public.customers where id = v_inv.customer_id;
    select jsonb_agg(jsonb_build_object('description', description, 'quantity', quantity, 'unit_price', unit_price,
             'amount', amount, 'tax_rate', tax_rate, 'is_reduced', is_reduced) order by description)
      into v_lines from public.invoice_lines where invoice_id = p_source_id;
    select jsonb_agg(jsonb_build_object('rate', tax_rate, 'reduced', is_reduced, 'base', taxable_amount, 'tax', tax_amount)
             order by tax_rate desc)
      into v_brk from public.invoice_tax_summary where invoice_id = p_source_id;
    v_no := v_inv.invoice_no; v_date := v_inv.issue_date;
    v_content := v_head || jsonb_build_object('official', v_set.erp_invoice_official, 'mf_invoice_no', v_inv.mf_invoice_no,
      'bank_info', v_set.bank_info, 'period_from', v_inv.period_from, 'period_to', v_inv.period_to, 'due_date', v_inv.due_date,
      'lines', v_lines, 'subtotal', v_inv.subtotal, 'tax_breakdown', v_brk, 'tax', v_inv.tax, 'total', v_inv.total);
  else
    raise exception '帳票の種類が不正です: %', p_type;
  end if;

  return v_content || jsonb_build_object('doc_no', v_no, 'doc_date', v_date,
    'customer', jsonb_build_object('id', v_cust.id, 'name', v_cust.name, 'postal_code', v_cust.postal_code,
                                   'address', v_cust.address, 'contact_name', v_cust.contact_name));
end $$;

-- 発行せずに内容を返す（保存しない）。画面の発行イメージに使う
create function public.preview_document(p_type text, p_source_id uuid)
returns jsonb language sql stable as $$
  select public.build_document_content(p_type, p_source_id, true)
$$;

-- 発行（内容の固定・版管理）。組み立ては共通の関数に任せる
create or replace function public.issue_document(p_type text, p_source_id uuid)
returns uuid language plpgsql as $$
declare
  v_content jsonb := public.build_document_content(p_type, p_source_id, false);
  v_hash    text;
  v_last    public.issued_documents;
  v_id      uuid;
begin
  v_hash := encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex');
  select * into v_last from public.issued_documents where doc_type = p_type and source_id = p_source_id
   order by version desc limit 1;
  if found and not v_last.voided and v_last.content_sha256 = v_hash then return v_last.id; end if;

  insert into public.issued_documents (doc_type, source_id, doc_no, version, doc_date, amount, counterparty_id, counterparty_name, content, content_sha256)
  values (p_type, p_source_id, v_content->>'doc_no', coalesce(v_last.version, 0) + 1, (v_content->>'doc_date')::date,
          coalesce(v_content->>'total', v_content->>'subtotal')::numeric,
          (v_content->'customer'->>'id')::uuid, v_content->'customer'->>'name', v_content, v_hash)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.build_document_content(text, uuid, boolean), public.preview_document(text, uuid) from public, anon;
grant  execute on function public.build_document_content(text, uuid, boolean), public.preview_document(text, uuid) to authenticated;
