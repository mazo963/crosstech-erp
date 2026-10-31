-- =====================================================================
-- 帳票の宛先（住所・担当部署名・担当者名）
--   * 得意先マスタ: 担当部署名（department）と、帳票に表示する既定（住所・担当部署・担当者）を持つ
--   * doc_addressees: 帳票（見積書=案件、納品書=納品、請求書=請求書）ごとの変更。マスタの値と、表示する／しないを上書きできる
--   * resolve_addressee: 実際に使う宛先を決める。納品書・請求書は、その案件の見積書の設定を引き継ぐ（無ければマスタ）
--   * build_document_content: 帳票の内容に、表示する項目だけを入れる（印刷されたものが、そのまま内容になる）
-- =====================================================================
alter table public.customers
  add column department   text,
  add column show_address    boolean not null default true,
  add column show_department boolean not null default true,
  add column show_contact    boolean not null default true;

create table public.doc_addressees (
  doc_type        text not null check (doc_type in ('quote','delivery_note','invoice')),
  source_id       uuid not null,                         -- 案件 / 納品 / 請求書 の id
  postal_code     text,
  address         text,
  department      text,
  contact_name    text,
  show_address    boolean,                               -- null = 得意先マスタの既定に従う
  show_department boolean,
  show_contact    boolean,
  updated_by      uuid references public.staff(id) default auth.uid(),
  updated_at      timestamptz not null default now(),
  primary key (doc_type, source_id)
);
create trigger trg_doc_addressees_updated before update on public.doc_addressees
  for each row execute function public.tg_set_updated_at();
alter table public.doc_addressees enable row level security;
revoke all on public.doc_addressees from anon;
create policy doc_addressees_select on public.doc_addressees for select to authenticated using (public.is_staff());
create policy doc_addressees_insert on public.doc_addressees for insert to authenticated with check (public.can_write());
create policy doc_addressees_update on public.doc_addressees for update to authenticated using (public.can_write()) with check (public.can_write());
create policy doc_addressees_delete on public.doc_addressees for delete to authenticated using (public.can_write());

create function public.resolve_addressee(p_type text, p_source_id uuid)
returns jsonb language plpgsql stable as $$
declare
  v_cust    public.customers;
  v_row     public.doc_addressees;
  v_project uuid;
  v_src     text := 'master';
begin
  if p_type = 'quote' then
    select c.* into v_cust from public.projects p join public.customers c on c.id = p.customer_id where p.id = p_source_id;
    v_project := p_source_id;
  elsif p_type = 'delivery_note' then
    select c.* into v_cust from public.deliveries d join public.projects p on p.id = d.project_id
      join public.customers c on c.id = p.customer_id where d.id = p_source_id;
    select project_id into v_project from public.deliveries where id = p_source_id;
  elsif p_type = 'invoice' then
    select c.* into v_cust from public.invoices i join public.customers c on c.id = i.customer_id where i.id = p_source_id;
    -- 請求書の明細が、1つの案件だけから成るとき、その案件の見積書の設定を引き継ぐ
    select case when count(distinct d.project_id) = 1 then (array_agg(distinct d.project_id))[1] end into v_project
      from public.invoice_lines il join public.delivery_lines dl on dl.id = il.delivery_line_id join public.deliveries d on d.id = dl.delivery_id
     where il.invoice_id = p_source_id;
  else
    raise exception '帳票の種類が不正です: %', p_type;
  end if;
  if v_cust.id is null then raise exception '得意先が見つかりません'; end if;

  select * into v_row from public.doc_addressees where doc_type = p_type and source_id = p_source_id;
  if found then v_src := 'document';
  elsif p_type <> 'quote' and v_project is not null then
    select * into v_row from public.doc_addressees where doc_type = 'quote' and source_id = v_project;
    if found then v_src := 'quote'; end if;
  end if;

  return jsonb_build_object(
    'source', v_src,
    'customer_id', v_cust.id,
    'values', jsonb_build_object(
      'postal_code',  coalesce(v_row.postal_code,  v_cust.postal_code),
      'address',      coalesce(v_row.address,      v_cust.address),
      'department',   coalesce(v_row.department,   v_cust.department),
      'contact_name', coalesce(v_row.contact_name, v_cust.contact_name)),
    'show', jsonb_build_object(
      'address',    coalesce(v_row.show_address,    v_cust.show_address),
      'department', coalesce(v_row.show_department, v_cust.show_department),
      'contact',    coalesce(v_row.show_contact,    v_cust.show_contact)),
    'master', jsonb_build_object(
      'postal_code', v_cust.postal_code, 'address', v_cust.address, 'department', v_cust.department, 'contact_name', v_cust.contact_name,
      'show_address', v_cust.show_address, 'show_department', v_cust.show_department, 'show_contact', v_cust.show_contact));
end $$;

create or replace function public.build_document_content(p_type text, p_source_id uuid, p_allow_draft boolean default false)
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
  v_addr    jsonb;
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

  -- 宛先: 得意先マスタの値を既定に、帳票・案件ごとの変更を反映する。「表示しない」にした項目は、帳票の内容に入れない
  v_addr := public.resolve_addressee(p_type, p_source_id);
  return v_content || jsonb_build_object('doc_no', v_no, 'doc_date', v_date,
    'customer', jsonb_build_object('id', v_cust.id, 'name', v_cust.name,
      'postal_code',  case when (v_addr->'show'->>'address')::boolean    then v_addr->'values'->>'postal_code' end,
      'address',      case when (v_addr->'show'->>'address')::boolean    then v_addr->'values'->>'address' end,
      'department',   case when (v_addr->'show'->>'department')::boolean then v_addr->'values'->>'department' end,
      'contact_name', case when (v_addr->'show'->>'contact')::boolean    then v_addr->'values'->>'contact_name' end));
end $$;

revoke execute on function public.resolve_addressee(text, uuid) from public, anon;
grant  execute on function public.resolve_addressee(text, uuid) to authenticated;
