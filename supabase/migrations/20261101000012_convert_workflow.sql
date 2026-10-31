-- =====================================================================
-- 見積 → 受注 → 納品 → 請求 の変換（ボタン一つで次の書類へ）
--   * order_project      : 見積を受注にする
--   * deliver_all        : 残りの全数量を納品として記録する（全数納品。分納は従来どおり record_delivery）
--   * create_invoice_for_project  : 案件の未請求の納品を、1枚の請求書にする
--   * create_invoice_for_delivery : 1回の納品を、1枚の請求書にする
--   * create_invoice（締め請求）  : 従来どおり。得意先×締め日で、複数案件をまとめる
--   同じ納品を二重に請求しない・全数完納の得意先の設定を守る、は従来と同じくDBが保証する
-- =====================================================================

-- 請求書の作り方（締め請求 / 案件単位 / 納品単位）
alter table public.invoices
  add column kind text not null default 'closing' check (kind in ('closing','project','delivery'));

-- 請求書の作成（共通）。締め請求は締め日までの未請求の納品行、それ以外は対象の案件・納品の未請求の行を集める
create function public.create_invoice_core(
  p_customer_id uuid,
  p_period_to   date,
  p_issue_date  date,
  p_kind        text,
  p_project_id  uuid default null,
  p_delivery_id uuid default null
) returns uuid language plpgsql as $$
declare
  v_cust     public.customers;
  v_set      public.company_settings;
  v_id       uuid;
  v_limit    date := case when p_kind = 'closing' then p_period_to else date '9999-12-31' end;
  v_from     date;
  v_to       date;
  v_subtotal numeric;
  v_tax      numeric;
  v_rates    integer;
  v_rate     numeric;
begin
  select * into v_cust from public.customers where id = p_customer_id;
  if not found then raise exception '得意先が見つかりません'; end if;
  select * into v_set from public.company_settings where id = 1;

  -- 対象の納品行（全数完納の得意先は、案件の全品目が納品済みのものだけ）
  select min(u.delivered_on), max(u.delivered_on) into v_from, v_to
    from public.v_unbilled_lines u
   where u.customer_id = p_customer_id and u.delivered_on <= v_limit
     and (p_project_id is null or u.project_id = p_project_id)
     and (p_delivery_id is null or u.delivery_id = p_delivery_id)
     and (v_cust.billing_basis = 'per_delivery' or u.project_fully_delivered);
  if v_from is null then
    raise exception '請求対象の納品がありません%', case when p_kind = 'closing' then '（締め日: ' || p_period_to || '）' else '（すでに請求済みか、取消済みです）' end;
  end if;

  if p_kind = 'closing' then
    -- 期間の開始は「前回の締め請求の締め日の翌日」。案件・納品単位の請求書は数えない
    select max(period_to) + 1 into v_from
      from public.invoices where customer_id = p_customer_id and status <> 'void' and kind = 'closing';
    v_to := p_period_to;
  end if;

  insert into public.invoices (invoice_no, customer_id, period_from, period_to, issue_date, due_date, tax_rate, kind)
  values (
    public.next_doc_no('INV', p_issue_date), p_customer_id, v_from, v_to, p_issue_date,
    public.calc_due_date(v_to, v_cust.payment_month_offset, v_cust.payment_day), null, p_kind
  ) returning id into v_id;

  insert into public.invoice_lines (invoice_id, delivery_line_id, description, quantity, unit_price, amount, tax_category, tax_rate, is_reduced)
  select v_id, u.delivery_line_id,
         u.product_no || ' ' || u.item_name || '（' || u.delivery_no || ' ' || to_char(u.delivered_on, 'MM/DD') || '納品）',
         u.quantity, u.unit_price, u.amount, dl.tax_category, dl.tax_rate, dl.is_reduced
    from public.v_unbilled_lines u
    join public.delivery_lines dl on dl.id = u.delivery_line_id
   where u.customer_id = p_customer_id and u.delivered_on <= v_limit
     and (p_project_id is null or u.project_id = p_project_id)
     and (p_delivery_id is null or u.delivery_id = p_delivery_id)
     and (v_cust.billing_basis = 'per_delivery' or u.project_fully_delivered)
   order by u.delivered_on, u.product_no;

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

-- 締め請求（従来の関数。共通の関数に任せる）
create or replace function public.create_invoice(
  p_customer_id uuid,
  p_period_to   date,
  p_issue_date  date default current_date
) returns uuid language sql as $$
  select public.create_invoice_core(p_customer_id, p_period_to, p_issue_date, 'closing')
$$;

-- 全数完納の得意先は、案件の全品目を納品してから請求する（その設定を、案件・納品単位の請求でも守る）
create function public.check_invoice_basis(p_project_id uuid)
returns void language plpgsql stable as $$
declare v_basis text;
begin
  select c.billing_basis into v_basis from public.projects p join public.customers c on c.id = p.customer_id where p.id = p_project_id;
  if v_basis = 'on_completion' and exists (
    select 1 from public.v_item_progress i where i.project_id = p_project_id and i.remaining_qty > 0
  ) then
    raise exception 'この得意先は、案件の全品目を納品してから請求する設定です。残りの品目を納品してから請求してください';
  end if;
end $$;

create function public.create_invoice_for_project(p_project_id uuid, p_issue_date date default current_date)
returns uuid language plpgsql as $$
declare v_cust uuid;
begin
  select customer_id into v_cust from public.projects where id = p_project_id;
  if v_cust is null then raise exception '案件が見つかりません'; end if;
  perform public.check_invoice_basis(p_project_id);
  return public.create_invoice_core(v_cust, current_date, p_issue_date, 'project', p_project_id, null);
end $$;

create function public.create_invoice_for_delivery(p_delivery_id uuid, p_issue_date date default current_date)
returns uuid language plpgsql as $$
declare d public.deliveries; v_cust uuid;
begin
  select * into d from public.deliveries where id = p_delivery_id;
  if not found then raise exception '納品が見つかりません'; end if;
  if d.voided then raise exception '取消された納品は請求できません'; end if;
  select customer_id into v_cust from public.projects where id = d.project_id;
  perform public.check_invoice_basis(d.project_id);
  return public.create_invoice_core(v_cust, current_date, p_issue_date, 'delivery', null, p_delivery_id);
end $$;

-- 見積を受注にする
create function public.order_project(p_project_id uuid, p_order_date date default current_date, p_customer_po_no text default null)
returns void language plpgsql as $$
begin
  if not exists (select 1 from public.project_items where project_id = p_project_id) then raise exception '品目がありません'; end if;
  update public.projects
     set status = 'ordered', order_date = coalesce(order_date, p_order_date),
         customer_po_no = coalesce(nullif(btrim(p_customer_po_no), ''), customer_po_no)
   where id = p_project_id and status = 'estimate';
  if not found then raise exception '見積中の案件だけ、受注にできます'; end if;
end $$;

-- 残りの全数量を納品として記録する（全数納品）。失注・完了の案件は不可
create function public.deliver_all(p_project_id uuid, p_delivered_on date default current_date, p_notes text default null)
returns uuid language plpgsql as $$
declare v_lines jsonb; v_status text;
begin
  select status into v_status from public.projects where id = p_project_id;
  if v_status is null then raise exception '案件が見つかりません'; end if;
  if v_status in ('lost', 'closed') then raise exception '失注・完了の案件は納品できません'; end if;
  select jsonb_agg(jsonb_build_object('item_id', id, 'quantity', remaining_qty)) into v_lines
    from public.v_item_progress where project_id = p_project_id and remaining_qty > 0;
  if v_lines is null then raise exception '納品していない数量がありません（すべて納品済みです）'; end if;
  return public.record_delivery(p_project_id, p_delivered_on, v_lines, p_notes);
end $$;

-- 納品の一覧（請求の状況・納品書の発行状況つき）
create view public.v_delivery_list with (security_invoker = true) as
select d.id, d.delivery_no, d.delivered_on, d.notes, d.voided, d.void_reason,
       p.id as project_id, p.project_no, p.title as project_title, c.id as customer_id, c.name as customer_name,
       coalesce(a.amount, 0) as amount,
       inv.invoice_id, inv.invoice_no, inv.invoice_status,
       doc.doc_id, doc.doc_version
  from public.deliveries d
  join public.projects p on p.id = d.project_id
  join public.customers c on c.id = p.customer_id
  left join lateral (select sum(dl.amount) as amount from public.delivery_lines dl where dl.delivery_id = d.id) a on true
  left join lateral (
    select i.id as invoice_id, i.invoice_no, i.status as invoice_status
      from public.invoice_lines il
      join public.delivery_lines dl on dl.id = il.delivery_line_id
      join public.invoices i on i.id = il.invoice_id
     where dl.delivery_id = d.id and i.status <> 'void'
     order by i.created_at desc limit 1
  ) inv on true
  left join lateral (
    select x.id as doc_id, x.version as doc_version from public.issued_documents x
     where x.doc_type = 'delivery_note' and x.source_id = d.id order by x.version desc limit 1
  ) doc on true;
revoke all on public.v_delivery_list from anon;

revoke execute on function public.create_invoice_core(uuid, date, date, text, uuid, uuid), public.check_invoice_basis(uuid),
  public.create_invoice_for_project(uuid, date), public.create_invoice_for_delivery(uuid, date),
  public.order_project(uuid, date, text), public.deliver_all(uuid, date, text) from public, anon;
grant execute on function public.create_invoice_core(uuid, date, date, text, uuid, uuid), public.check_invoice_basis(uuid),
  public.create_invoice_for_project(uuid, date), public.create_invoice_for_delivery(uuid, date),
  public.order_project(uuid, date, text), public.deliver_all(uuid, date, text) to authenticated;
