-- =====================================================================
-- 複数税率（標準・軽減・今後の税率変更に対応）
--   * 税区分（標準税率 / 軽減税率 …）と、区分ごとの「期間つき税率」をデータで持つ。税率の追加・変更にコード変更は不要
--   * 品目が税区分を持ち、納品の記録時に「納品日時点の税率」を納品行へ固定する（資産の譲渡等の時の税率）
--   * 請求書は税率ごとに集計し、消費税は請求書1枚・税率ごとに1回だけ端数処理する
--   将来の税率（予定を含む）は、公表・施行が確定してから set_tax_rate で登録する（ここでは登録しない）
-- =====================================================================

create table public.tax_categories (
  code        text primary key,
  name        text not null,
  is_reduced  boolean not null default false,     -- 軽減税率の対象（帳票に ※ を付ける）
  sort_order  smallint not null default 0,
  active      boolean not null default true
);

create table public.tax_rate_periods (
  id             uuid primary key default gen_random_uuid(),
  category_code  text not null references public.tax_categories(code),
  rate           numeric(5,4) not null check (rate >= 0 and rate < 1),
  valid_from     date not null,
  valid_to       date,                             -- null = 現在も有効
  created_by     uuid references public.staff(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  unique (category_code, valid_from)
);

create function public.tg_tax_period_overlap()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.tax_rate_periods o
     where o.category_code = new.category_code and o.id <> new.id
       and new.valid_from <= coalesce(o.valid_to, 'infinity'::date)
       and coalesce(new.valid_to, 'infinity'::date) >= o.valid_from
  ) then
    raise exception '税区分 % の適用期間が重なっています', new.category_code;
  end if;
  return new;
end $$;
create trigger trg_tax_period_overlap before insert or update on public.tax_rate_periods
  for each row execute function public.tg_tax_period_overlap();
create trigger trg_audit_tax_periods after insert or update or delete on public.tax_rate_periods
  for each row execute function public.tg_audit();

insert into public.tax_categories (code, name, is_reduced, sort_order)
values ('standard', '標準税率', false, 1), ('reduced', '軽減税率', true, 2);
insert into public.tax_rate_periods (category_code, rate, valid_from)
select 'standard', tax_rate, date '2019-10-01' from public.company_settings where id = 1;
insert into public.tax_rate_periods (category_code, rate, valid_from) values ('reduced', 0.08, date '2019-10-01');

-- 指定日に適用される税率（無ければエラー。黙って別の税率を使わない）
create function public.tax_rate_on(p_category text, p_date date)
returns numeric language plpgsql stable as $$
declare v numeric;
begin
  select rate into v from public.tax_rate_periods
   where category_code = p_category and valid_from <= p_date and (valid_to is null or p_date <= valid_to);
  if v is null then
    raise exception '税区分 % の % 時点の税率が登録されていません', p_category, p_date;
  end if;
  return v;
end $$;

-- 税率の変更（管理者のみ）。直前の期間を前日で閉じ、新しい期間を開く。
--   すでにその日以降の納品が記録されている税区分は、さかのぼって変更できない（納品行の税率は固定のため）
create function public.set_tax_rate(p_category text, p_rate numeric, p_valid_from date)
returns void language plpgsql as $$
begin
  if not public.is_admin() then raise exception '税率を変更できるのは管理者だけです'; end if;
  if not exists (select 1 from public.tax_categories where code = p_category) then raise exception '税区分が見つかりません'; end if;
  if exists (
    select 1 from public.delivery_lines dl join public.deliveries d on d.id = dl.delivery_id
     where dl.tax_category = p_category and not d.voided and d.delivered_on >= p_valid_from
  ) then
    raise exception 'この日以降の納品がすでに記録されているため、税率を変更できません（%）', p_valid_from;
  end if;
  update public.tax_rate_periods set valid_to = p_valid_from - 1
   where category_code = p_category and valid_to is null and valid_from < p_valid_from;
  insert into public.tax_rate_periods (category_code, rate, valid_from) values (p_category, p_rate, p_valid_from);
end $$;

-- 品目・納品行・請求行に税区分と税率を持たせる
alter table public.project_items add column tax_category text not null default 'standard' references public.tax_categories(code);

alter table public.delivery_lines
  add column tax_category text references public.tax_categories(code),
  add column tax_rate numeric(5,4),
  add column is_reduced boolean;
update public.delivery_lines dl set tax_category = 'standard', is_reduced = false,
  tax_rate = coalesce((select p.rate from public.tax_rate_periods p join public.deliveries d on d.id = dl.delivery_id
                        where p.category_code = 'standard' and p.valid_from <= d.delivered_on
                          and (p.valid_to is null or d.delivered_on <= p.valid_to)),
                      (select tax_rate from public.company_settings where id = 1));
alter table public.delivery_lines alter column tax_category set not null, alter column tax_rate set not null, alter column is_reduced set not null;

alter table public.invoice_lines
  add column tax_category text references public.tax_categories(code),
  add column tax_rate numeric(5,4),
  add column is_reduced boolean;
update public.invoice_lines il set tax_category = 'standard', is_reduced = false,
  tax_rate = (select i.tax_rate from public.invoices i where i.id = il.invoice_id);
alter table public.invoice_lines alter column tax_category set not null, alter column tax_rate set not null, alter column is_reduced set not null;

-- 請求書の税率別集計。invoices.tax_rate は、1つの税率だけのときのみ入る（混在のときは null）
alter table public.invoices alter column tax_rate drop not null;
create table public.invoice_tax_summary (
  invoice_id      uuid not null references public.invoices(id),
  tax_rate        numeric(5,4) not null,
  is_reduced      boolean not null,
  taxable_amount  numeric(14,0) not null,
  tax_amount      numeric(14,0) not null,
  primary key (invoice_id, tax_rate)
);
insert into public.invoice_tax_summary (invoice_id, tax_rate, is_reduced, taxable_amount, tax_amount)
select id, tax_rate, false, subtotal, tax from public.invoices;

-- RLS: 税マスタは閲覧=スタッフ、税区分の追加=管理者。税率の期間は set_tax_rate 経由のみ
do $$
declare t text;
begin
  foreach t in array array['tax_categories','tax_rate_periods','invoice_tax_summary'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke update, delete, truncate on public.%I from authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_select', t);
  end loop;
end $$;
create policy tax_categories_insert on public.tax_categories for insert to authenticated with check (public.is_admin());
create policy invoice_tax_summary_insert on public.invoice_tax_summary for insert to authenticated with check (public.can_write());
-- 期間の登録・変更は set_tax_rate（呼び出したユーザーが管理者であることを関数内で確認）の中で行う
create policy tax_rate_periods_insert on public.tax_rate_periods for insert to authenticated with check (public.is_admin());
grant update (valid_to) on public.tax_rate_periods to authenticated;
create policy tax_rate_periods_update on public.tax_rate_periods for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 納品の記録: 納品日時点の税区分・税率を納品行へ固定する
-- ---------------------------------------------------------------------
create or replace function public.record_delivery(
  p_project_id   uuid,
  p_delivered_on date,
  p_lines        jsonb,
  p_notes        text default null
) returns uuid language plpgsql as $$
declare
  v_id    uuid;
  v_line  jsonb;
  v_item  public.project_items;
  v_qty   numeric;
  v_count integer := 0;
begin
  insert into public.deliveries (delivery_no, project_id, delivered_on, notes)
  values (public.next_doc_no('DN', p_delivered_on), p_project_id, p_delivered_on, p_notes)
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line->>'quantity')::numeric;
    continue when v_qty is null or v_qty <= 0;
    select * into v_item from public.project_items where id = (v_line->>'item_id')::uuid;
    if not found then raise exception '品目が見つかりません: %', v_line->>'item_id'; end if;
    insert into public.delivery_lines (delivery_id, project_item_id, quantity, unit_price, amount, tax_category, tax_rate, is_reduced)
    values (v_id, v_item.id, v_qty, v_item.sale_unit_price, floor(v_qty * v_item.sale_unit_price),
            v_item.tax_category, public.tax_rate_on(v_item.tax_category, p_delivered_on),
            (select is_reduced from public.tax_categories where code = v_item.tax_category));
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then raise exception '納品数量が入力されていません'; end if;
  update public.projects set status = 'ordered' where id = p_project_id and status = 'estimate';
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 締め請求書の作成: 税率ごとに集計し、税率ごとに1回だけ端数処理
-- ---------------------------------------------------------------------
create or replace function public.create_invoice(
  p_customer_id uuid,
  p_period_to   date,
  p_issue_date  date default current_date
) returns uuid language plpgsql as $$
declare
  v_cust     public.customers;
  v_set      public.company_settings;
  v_id       uuid;
  v_from     date;
  v_subtotal numeric;
  v_tax      numeric;
  v_rates    integer;
  v_rate     numeric;
begin
  select * into v_cust from public.customers where id = p_customer_id;
  if not found then raise exception '得意先が見つかりません'; end if;
  select * into v_set from public.company_settings where id = 1;

  select max(period_to) + 1 into v_from
    from public.invoices where customer_id = p_customer_id and status <> 'void';

  insert into public.invoices (invoice_no, customer_id, period_from, period_to, issue_date, due_date, tax_rate)
  values (
    public.next_doc_no('INV', p_issue_date), p_customer_id, v_from, p_period_to, p_issue_date,
    public.calc_due_date(p_period_to, v_cust.payment_month_offset, v_cust.payment_day),
    null
  ) returning id into v_id;

  insert into public.invoice_lines (invoice_id, delivery_line_id, description, quantity, unit_price, amount, tax_category, tax_rate, is_reduced)
  select v_id, u.delivery_line_id,
         u.product_no || ' ' || u.item_name || '（' || u.delivery_no || ' ' || to_char(u.delivered_on, 'MM/DD') || '納品）',
         u.quantity, u.unit_price, u.amount, dl.tax_category, dl.tax_rate, dl.is_reduced
    from public.v_unbilled_lines u
    join public.delivery_lines dl on dl.id = u.delivery_line_id
   where u.customer_id = p_customer_id
     and u.delivered_on <= p_period_to
     and (v_cust.billing_basis = 'per_delivery' or u.project_fully_delivered)
   order by u.delivered_on, u.product_no;

  if not exists (select 1 from public.invoice_lines where invoice_id = v_id) then
    raise exception '請求対象の納品がありません（締め日: %）', p_period_to;
  end if;

  insert into public.invoice_tax_summary (invoice_id, tax_rate, is_reduced, taxable_amount, tax_amount)
  select v_id, tax_rate, bool_or(is_reduced), sum(amount), public.round_tax(sum(amount) * tax_rate, v_set.tax_rounding)
    from public.invoice_lines where invoice_id = v_id group by tax_rate;

  select sum(taxable_amount), sum(tax_amount), count(*), max(tax_rate)
    into v_subtotal, v_tax, v_rates, v_rate from public.invoice_tax_summary where invoice_id = v_id;
  update public.invoices
     set subtotal = v_subtotal, tax = v_tax, total = v_subtotal + v_tax, tax_rate = case when v_rates = 1 then v_rate end
   where id = v_id;
  return v_id;
end $$;

revoke execute on function public.tax_rate_on(text, date), public.set_tax_rate(text, numeric, date) from public, anon;
grant  execute on function public.tax_rate_on(text, date), public.set_tax_rate(text, numeric, date) to authenticated;

-- ---------------------------------------------------------------------
-- 帳票の発行: 税率別の内訳（tax_breakdown）と、軽減税率の明細（is_reduced）を固定内容に含める
--   見積書は見積日時点の税率、納品書は納品行に固定した税率、請求書は請求書の税率別集計を使う
-- ---------------------------------------------------------------------
create or replace function public.issue_document(p_type text, p_source_id uuid)
returns uuid language plpgsql as $$
declare
  v_set     public.company_settings;
  v_cust    public.customers;
  v_proj    public.projects;
  v_dv      public.deliveries;
  v_inv     public.invoices;
  v_no      text;
  v_date    date;
  v_amount  numeric;
  v_sub     numeric;
  v_tax     numeric;
  v_lines   jsonb;
  v_brk     jsonb;
  v_head    jsonb;
  v_content jsonb;
  v_hash    text;
  v_last    public.issued_documents;
  v_id      uuid;
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
    v_no := v_proj.project_no; v_amount := v_sub + v_tax;
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
    v_no := v_dv.delivery_no; v_date := v_dv.delivered_on; v_amount := v_sub;
    v_content := v_head || jsonb_build_object('project_no', (select project_no from public.projects where id = v_dv.project_id),
      'title', (select title from public.projects where id = v_dv.project_id),
      'customer_po_no', (select customer_po_no from public.projects where id = v_dv.project_id),
      'notes', v_dv.notes, 'lines', v_lines, 'subtotal', v_sub);

  elsif p_type = 'invoice' then
    select * into v_inv from public.invoices where id = p_source_id;
    if not found then raise exception '請求書が見つかりません'; end if;
    if v_inv.status <> 'issued' then raise exception '発行済みの請求書だけ帳票を発行できます'; end if;
    select * into v_cust from public.customers where id = v_inv.customer_id;
    select jsonb_agg(jsonb_build_object('description', description, 'quantity', quantity, 'unit_price', unit_price,
             'amount', amount, 'tax_rate', tax_rate, 'is_reduced', is_reduced) order by description)
      into v_lines from public.invoice_lines where invoice_id = p_source_id;
    select jsonb_agg(jsonb_build_object('rate', tax_rate, 'reduced', is_reduced, 'base', taxable_amount, 'tax', tax_amount)
             order by tax_rate desc)
      into v_brk from public.invoice_tax_summary where invoice_id = p_source_id;
    v_no := v_inv.invoice_no; v_date := v_inv.issue_date; v_amount := v_inv.total;
    v_content := v_head || jsonb_build_object('official', v_set.erp_invoice_official, 'mf_invoice_no', v_inv.mf_invoice_no,
      'bank_info', v_set.bank_info, 'period_from', v_inv.period_from, 'period_to', v_inv.period_to, 'due_date', v_inv.due_date,
      'lines', v_lines, 'subtotal', v_inv.subtotal, 'tax_breakdown', v_brk, 'tax', v_inv.tax, 'total', v_inv.total);
  else
    raise exception '帳票の種類が不正です: %', p_type;
  end if;

  v_content := v_content || jsonb_build_object('doc_no', v_no, 'doc_date', v_date,
    'customer', jsonb_build_object('id', v_cust.id, 'name', v_cust.name, 'postal_code', v_cust.postal_code,
                                   'address', v_cust.address, 'contact_name', v_cust.contact_name));

  v_hash := encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex');
  select * into v_last from public.issued_documents where doc_type = p_type and source_id = p_source_id
   order by version desc limit 1;
  if found and not v_last.voided and v_last.content_sha256 = v_hash then return v_last.id; end if;

  insert into public.issued_documents (doc_type, source_id, doc_no, version, doc_date, amount, counterparty_id, counterparty_name, content, content_sha256)
  values (p_type, p_source_id, v_no, coalesce(v_last.version, 0) + 1, v_date, v_amount, v_cust.id, v_cust.name, v_content, v_hash)
  returning id into v_id;
  return v_id;
end $$;
