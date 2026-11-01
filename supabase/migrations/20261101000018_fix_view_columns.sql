-- =====================================================================
-- 不具合の修正: ビューが後から追加された列を含んでいなかった
--   v_item_progress は `select i.*` で作られており、PostgreSQL はビューの作成時点の列に展開する。
--   そのため、あとで project_items に追加した tax_category が、画面（案件の品目の入力表）に渡らなかった。
--   結果として、軽減税率の品目を持つ案件を開いて保存し直すと、税区分が「標準税率」に書き換わっていた。
--   → ビューに tax_category を追加する（列の追加は末尾のみ可能なため、末尾に足す）。
--   v_invoice_balance も同じ理由で kind（請求書の種類）が無かったので、末尾に足す。
--   再発防止: scripts/test_views.sql が、ビューに元のテーブルの列がすべてあることを確認する。
-- =====================================================================
create or replace view public.v_item_progress with (security_invoker = true) as
select
  i.id, i.project_id, i.line_no, i.product_no, i.customer_part_no, i.name, i.spec, i.vendor_id, i.quantity, i.unit,
  i.cost_unit_price, i.sale_unit_price, i.due_date, i.juchu_completed_at, i.juchu_shipped_date, i.juchu_synced_at,
  i.created_at, i.updated_at,
  p.project_no,
  p.customer_id,
  p.status as project_status,
  floor(i.quantity * i.sale_unit_price)  as sale_amount,
  floor(i.quantity * i.cost_unit_price)  as cost_amount,
  coalesce(d.delivered_qty, 0)           as delivered_qty,
  i.quantity - coalesce(d.delivered_qty, 0) as remaining_qty,
  coalesce(b.invoiced_qty, 0)            as invoiced_qty,
  i.tax_category
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

create or replace view public.v_invoice_balance with (security_invoker = true) as
select
  inv.id, inv.invoice_no, inv.customer_id, inv.period_from, inv.period_to, inv.issue_date, inv.due_date, inv.subtotal,
  inv.tax_rate, inv.tax, inv.total, inv.status, inv.mf_invoice_no, inv.notes, inv.issued_by, inv.created_at, inv.updated_at,
  c.name as customer_name,
  coalesce(pa.allocated, 0) as allocated,
  case when inv.status = 'issued' then inv.total - coalesce(pa.allocated, 0) else 0 end as balance,
  inv.status = 'issued' and inv.due_date < current_date and (inv.total - coalesce(pa.allocated, 0)) > 0 as overdue,
  inv.kind
from public.invoices inv
join public.customers c on c.id = inv.customer_id
left join lateral (
  select sum(a.amount) as allocated
    from public.payment_allocations a
    join public.payments p on p.id = a.payment_id and not p.voided
   where a.invoice_id = inv.id
) pa on true;

grant select on public.v_item_progress, public.v_invoice_balance to authenticated;
