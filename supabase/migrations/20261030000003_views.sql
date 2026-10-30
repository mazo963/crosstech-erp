-- =====================================================================
-- CROSSTECH ERP  集計ビュー
-- security_invoker = true : 呼び出したユーザーのRLSがそのまま効く
-- =====================================================================

-- 品目ごとの進捗
create view public.v_item_progress with (security_invoker = true) as
select
  i.*,
  p.project_no,
  p.customer_id,
  p.status as project_status,
  floor(i.quantity * i.sale_unit_price)  as sale_amount,
  floor(i.quantity * i.cost_unit_price)  as cost_amount,
  coalesce(d.delivered_qty, 0)           as delivered_qty,
  i.quantity - coalesce(d.delivered_qty, 0) as remaining_qty,
  coalesce(b.invoiced_qty, 0)            as invoiced_qty
from public.project_items i
join public.projects p on p.id = i.project_id
left join lateral (
  select sum(dl.quantity) as delivered_qty
    from public.delivery_lines dl join public.deliveries dv on dv.id = dl.delivery_id
   where dl.project_item_id = i.id and not dv.voided
) d on true
left join lateral (
  select sum(il.quantity) as invoiced_qty
    from public.invoice_lines il
    join public.invoices inv on inv.id = il.invoice_id and inv.status <> 'void'
    join public.delivery_lines dl on dl.id = il.delivery_line_id
   where dl.project_item_id = i.id
) b on true;

-- 未請求の納品行（締め請求の材料）
create view public.v_unbilled_lines with (security_invoker = true) as
select
  dl.id            as delivery_line_id,
  dl.quantity, dl.unit_price, dl.amount,
  dv.id            as delivery_id,
  dv.delivery_no, dv.delivered_on,
  i.id             as item_id,
  i.product_no, i.name as item_name,
  p.id             as project_id,
  p.project_no, p.title as project_title,
  p.customer_id,
  not exists (
    select 1 from public.project_items i2
     where i2.project_id = p.id and public.delivered_qty(i2.id) < i2.quantity
  ) as project_fully_delivered
from public.delivery_lines dl
join public.deliveries dv  on dv.id = dl.delivery_id and not dv.voided
join public.project_items i on i.id = dl.project_item_id
join public.projects p      on p.id = i.project_id
where not exists (
  select 1 from public.invoice_lines il
    join public.invoices inv on inv.id = il.invoice_id
   where il.delivery_line_id = dl.id and inv.status <> 'void'
);

-- 案件サマリ（一覧・ダッシュボード用）
create view public.v_project_summary with (security_invoker = true) as
with agg as (
  select project_id,
         sum(sale_amount)   as sales_amount,
         sum(cost_amount)   as cost_amount,
         sum(quantity)      as total_qty,
         sum(delivered_qty) as delivered_qty,
         sum(invoiced_qty)  as invoiced_qty,
         count(*)           as item_count
    from public.v_item_progress group by project_id
)
select
  p.*,
  c.name as customer_name,
  s.name as lead_staff_name,
  coalesce(a.sales_amount, 0) as sales_amount,
  coalesce(a.cost_amount, 0)  as cost_amount,
  coalesce(a.sales_amount, 0) - coalesce(a.cost_amount, 0) as gross_profit,
  case when coalesce(a.sales_amount, 0) > 0
       then round((a.sales_amount - a.cost_amount) / a.sales_amount * 100, 1) end as margin_pct,
  coalesce(a.item_count, 0)    as item_count,
  coalesce(a.total_qty, 0)     as total_qty,
  coalesce(a.delivered_qty, 0) as delivered_qty,
  case when coalesce(a.total_qty, 0) > 0
       then round(a.delivered_qty / a.total_qty * 100) else 0 end as delivery_pct,
  case
    when p.status in ('estimate','lost','closed') then p.status
    when coalesce(a.delivered_qty, 0) = 0 then 'ordered'
    when a.delivered_qty < a.total_qty then 'partial'
    when a.invoiced_qty >= a.total_qty then 'invoiced'
    else 'delivered'
  end as progress
from public.projects p
join public.customers c on c.id = p.customer_id
left join public.staff s on s.id = p.lead_staff_id
left join agg a on a.project_id = p.id;

-- 請求書ごとの残高
create view public.v_invoice_balance with (security_invoker = true) as
select
  inv.*,
  c.name as customer_name,
  coalesce(pa.allocated, 0) as allocated,
  case when inv.status = 'issued' then inv.total - coalesce(pa.allocated, 0) else 0 end as balance,
  (inv.status = 'issued' and inv.due_date < current_date
     and inv.total - coalesce(pa.allocated, 0) > 0) as overdue
from public.invoices inv
join public.customers c on c.id = inv.customer_id
left join lateral (
  select sum(amount) as allocated from public.payment_allocations where invoice_id = inv.id
) pa on true;

-- 得意先ごとの売掛残高と、消込されていない入金（過入金・前受）
create view public.v_customer_balance with (security_invoker = true) as
select
  c.id as customer_id, c.name as customer_name,
  coalesce((select sum(balance) from public.v_invoice_balance b where b.customer_id = c.id), 0) as ar_balance,
  coalesce((select sum(p.amount + p.fee) from public.payments p where p.customer_id = c.id), 0)
  - coalesce((select sum(pa.amount) from public.payment_allocations pa
               join public.payments p on p.id = pa.payment_id where p.customer_id = c.id), 0)
    as unallocated_payment,
  coalesce((select sum(amount) from public.v_unbilled_lines u where u.customer_id = c.id), 0) as unbilled_amount
from public.customers c;

-- ダッシュボード（1行）
--   平均粗利率は「総粗利 ÷ 総売上」（加重平均）。単純平均は参考値
create view public.v_dashboard with (security_invoker = true) as
select
  coalesce(sum(sales_amount) filter (where status in ('ordered','closed')), 0) as total_order_amount,
  coalesce(sum(gross_profit) filter (where status in ('ordered','closed')), 0) as total_gross_profit,
  case when sum(sales_amount) filter (where status in ('ordered','closed')) > 0
       then round(sum(gross_profit) filter (where status in ('ordered','closed'))
                / sum(sales_amount) filter (where status in ('ordered','closed')) * 100, 1) end as weighted_margin_pct,
  round(avg(margin_pct) filter (where status in ('ordered','closed')), 1) as simple_avg_margin_pct,
  coalesce(sum(sales_amount) filter (where status = 'estimate'), 0) as estimate_amount,
  (select coalesce(sum(balance), 0) from public.v_invoice_balance)                as ar_balance,
  (select coalesce(sum(balance), 0) from public.v_invoice_balance where overdue)  as overdue_amount,
  (select coalesce(sum(amount), 0)  from public.v_unbilled_lines)                 as unbilled_amount
from public.v_project_summary;
