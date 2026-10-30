-- =====================================================================
-- CROSSTECH ERP  採番・業務ロジック（RPC）
-- 金額計算と整合性チェックはすべてDB側で行う（画面側で計算しない）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 採番: prefix + YYMM + 連番
--   PJ  → CRO261001      （案件番号。品目の社内製番は CRO261001-1, -2 ...）
--   DN  → DN2610-0001    （納品書）
--   INV → INV2610-0001   （請求書）
-- ---------------------------------------------------------------------
create or replace function public.next_doc_no(p_prefix text, p_date date default current_date)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_yymm text := to_char(p_date, 'YYMM');
  v_no   integer;
begin
  -- ログインユーザーは登録権限（admin/office）が必要。auth.uid() が null はサーバー内部処理
  if auth.uid() is not null and not public.can_write() then
    raise exception '採番の権限がありません';
  end if;
  insert into public.doc_counters (prefix, yymm, last_no) values (p_prefix, v_yymm, 1)
  on conflict (prefix, yymm) do update set last_no = doc_counters.last_no + 1
  returning last_no into v_no;

  if p_prefix = 'PJ' then
    return 'CRO' || v_yymm || case when v_no < 100 then lpad(v_no::text, 2, '0') else v_no::text end;
  end if;
  return p_prefix || v_yymm || '-' || lpad(v_no::text, greatest(4, length(v_no::text)), '0');
end $$;

alter table public.projects alter column project_no set default public.next_doc_no('PJ');

-- 品目の社内製番: 未入力なら「案件番号-行番号」を自動付与（手入力の既存製番も可）
create or replace function public.tg_item_defaults()
returns trigger language plpgsql as $$
declare v_pno text;
begin
  if new.line_no is null then
    select coalesce(max(line_no), 0) + 1 into new.line_no
      from public.project_items where project_id = new.project_id;
  end if;
  if new.product_no is null or btrim(new.product_no) = '' then
    select project_no into v_pno from public.projects where id = new.project_id;
    new.product_no := v_pno || '-' || new.line_no;
  end if;
  return new;
end $$;
create trigger trg_item_defaults before insert on public.project_items
  for each row execute function public.tg_item_defaults();

-- ---------------------------------------------------------------------
-- 品目の数量を「納品済み数量」未満に減らせないようにする
-- ---------------------------------------------------------------------
create or replace function public.delivered_qty(p_item_id uuid)
returns numeric language sql stable as $$
  select coalesce(sum(dl.quantity), 0)
    from public.delivery_lines dl
    join public.deliveries d on d.id = dl.delivery_id
   where dl.project_item_id = p_item_id and not d.voided
$$;

create or replace function public.tg_item_qty_guard()
returns trigger language plpgsql as $$
begin
  if new.quantity < public.delivered_qty(new.id) then
    raise exception '品目 % の数量を納品済み数量（%）より少なくできません',
      new.product_no, public.delivered_qty(new.id);
  end if;
  return new;
end $$;
create trigger trg_item_qty_guard before update of quantity on public.project_items
  for each row execute function public.tg_item_qty_guard();

-- ---------------------------------------------------------------------
-- 納品行: 受注数量を超える納品、別案件の品目の混入を防ぐ
-- ---------------------------------------------------------------------
create or replace function public.tg_delivery_line_guard()
returns trigger language plpgsql as $$
declare
  v_item     public.project_items;
  v_proj     uuid;
  v_already  numeric;
begin
  select * into v_item from public.project_items where id = new.project_item_id;
  select project_id into v_proj from public.deliveries where id = new.delivery_id;
  if v_item.project_id <> v_proj then
    raise exception '別の案件の品目は同じ納品書に入れられません';
  end if;
  select coalesce(sum(dl.quantity), 0) into v_already
    from public.delivery_lines dl
    join public.deliveries d on d.id = dl.delivery_id
   where dl.project_item_id = new.project_item_id and not d.voided and dl.id <> new.id;
  if v_already + new.quantity > v_item.quantity then
    raise exception '製番 % : 納品数の合計（%）が受注数量（%）を超えます',
      v_item.product_no, v_already + new.quantity, v_item.quantity;
  end if;
  return new;
end $$;
create trigger trg_delivery_line_guard before insert or update on public.delivery_lines
  for each row execute function public.tg_delivery_line_guard();

-- ---------------------------------------------------------------------
-- 納品の記録（分納）
--   p_lines: [{"item_id":"uuid","quantity":3}, ...]
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
    insert into public.delivery_lines (delivery_id, project_item_id, quantity, unit_price, amount)
    values (v_id, v_item.id, v_qty, v_item.sale_unit_price, floor(v_qty * v_item.sale_unit_price));
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then raise exception '納品数量が入力されていません'; end if;
  update public.projects set status = 'ordered' where id = p_project_id and status = 'estimate';
  return v_id;
end $$;

-- 納品の取消（請求書に載っている場合は不可。先に請求書を取消す）
create or replace function public.void_delivery(p_delivery_id uuid, p_reason text)
returns void language plpgsql as $$
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception '取消理由を入力してください'; end if;
  if exists (
    select 1 from public.invoice_lines il
      join public.invoices i on i.id = il.invoice_id
      join public.delivery_lines dl on dl.id = il.delivery_line_id
     where dl.delivery_id = p_delivery_id and i.status <> 'void'
  ) then
    raise exception 'この納品は請求書に計上済みです。先に請求書を取消してください';
  end if;
  update public.deliveries set voided = true, void_reason = p_reason where id = p_delivery_id;
end $$;

-- ---------------------------------------------------------------------
-- 支払期日の計算（締め日 → 支払条件）
-- ---------------------------------------------------------------------
create or replace function public.calc_due_date(p_period_to date, p_month_offset int, p_day int)
returns date language sql immutable as $$
  select case
    when p_day = 0 then p_period_to
    when p_day = 31 then (date_trunc('month', p_period_to) + make_interval(months => p_month_offset + 1) - interval '1 day')::date
    else (date_trunc('month', p_period_to) + make_interval(months => p_month_offset) + make_interval(days => p_day - 1))::date
  end
$$;

-- 締め日から「今回の締め期間の末日」を求める（基準日を含む期間）
create or replace function public.calc_period_end(p_base date, p_closing_day int)
returns date language sql immutable as $$
  select case
    when p_closing_day = 0 then p_base
    when p_closing_day = 31 then (date_trunc('month', p_base) + interval '1 month' - interval '1 day')::date
    when extract(day from p_base) <= p_closing_day
      then (date_trunc('month', p_base) + make_interval(days => p_closing_day - 1))::date
    else (date_trunc('month', p_base) + interval '1 month' + make_interval(days => p_closing_day - 1))::date
  end
$$;

-- 消費税の端数処理
create or replace function public.round_tax(p_amount numeric, p_mode text)
returns numeric language sql immutable as $$
  select case p_mode when 'round' then round(p_amount) when 'ceil' then ceil(p_amount) else floor(p_amount) end
$$;

-- ---------------------------------------------------------------------
-- 締め請求書の作成（下書き）
--   得意先の未請求の納品行のうち、納品日 <= 締め日 のものをまとめる
--   全数完納の得意先は、案件の全品目が納品済みの案件のみ対象
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
  v_subtotal numeric := 0;
  v_tax      numeric;
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
    v_set.tax_rate
  ) returning id into v_id;

  insert into public.invoice_lines (invoice_id, delivery_line_id, description, quantity, unit_price, amount)
  select v_id, u.delivery_line_id,
         u.product_no || ' ' || u.item_name || '（' || u.delivery_no || ' ' || to_char(u.delivered_on, 'MM/DD') || '納品）',
         u.quantity, u.unit_price, u.amount
    from public.v_unbilled_lines u
   where u.customer_id = p_customer_id
     and u.delivered_on <= p_period_to
     and (v_cust.billing_basis = 'per_delivery' or u.project_fully_delivered)
   order by u.delivered_on, u.product_no;

  select coalesce(sum(amount), 0) into v_subtotal from public.invoice_lines where invoice_id = v_id;
  if v_subtotal = 0 and not exists (select 1 from public.invoice_lines where invoice_id = v_id) then
    raise exception '請求対象の納品がありません（締め日: %）', p_period_to;
  end if;

  v_tax := public.round_tax(v_subtotal * v_set.tax_rate, v_set.tax_rounding);
  update public.invoices set subtotal = v_subtotal, tax = v_tax, total = v_subtotal + v_tax where id = v_id;
  return v_id;
end $$;

create or replace function public.issue_invoice(p_invoice_id uuid, p_mf_invoice_no text default null)
returns void language plpgsql as $$
begin
  update public.invoices
     set status = 'issued', mf_invoice_no = coalesce(p_mf_invoice_no, mf_invoice_no)
   where id = p_invoice_id and status = 'draft';
  if not found then raise exception '下書きの請求書だけ発行できます'; end if;
end $$;

create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void language plpgsql as $$
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception '取消理由を入力してください'; end if;
  if exists (select 1 from public.payment_allocations where invoice_id = p_invoice_id) then
    raise exception '入金消込済みの請求書は取消できません。先に入金を取消してください';
  end if;
  update public.invoices
     set status = 'void', notes = coalesce(notes || E'\n', '') || '取消理由: ' || p_reason
   where id = p_invoice_id and status <> 'void';
end $$;

-- ---------------------------------------------------------------------
-- 入金の記録（古い請求書から自動で消込）
--   amount = 実入金額、fee = 先方が差し引いた振込手数料。消込額 = amount + fee
-- ---------------------------------------------------------------------
create or replace function public.record_payment(
  p_customer_id uuid,
  p_received_on date,
  p_amount      numeric,
  p_fee         numeric default 0,
  p_method      text default 'bank',
  p_memo        text default null
) returns uuid language plpgsql as $$
declare
  v_id     uuid;
  v_left   numeric := p_amount + coalesce(p_fee, 0);
  v_inv    record;
  v_take   numeric;
begin
  insert into public.payments (customer_id, received_on, amount, fee, method, memo)
  values (p_customer_id, p_received_on, p_amount, coalesce(p_fee, 0), p_method, p_memo)
  returning id into v_id;

  for v_inv in
    select id, balance from public.v_invoice_balance
     where customer_id = p_customer_id and status = 'issued' and balance > 0
     order by due_date nulls last, issue_date, invoice_no
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_inv.balance);
    insert into public.payment_allocations (payment_id, invoice_id, amount) values (v_id, v_inv.id, v_take);
    v_left := v_left - v_take;
  end loop;
  -- v_left > 0 の場合は「前受・過入金」として残る（v_customer_balance で確認）
  return v_id;
end $$;

-- 休止防止の疎通（GitHub Actions から呼ぶ。認証なしで呼べるのはこれだけ）
create or replace function public.ping()
returns timestamptz language sql security definer set search_path = public as $$
  update public.keepalive set pinged = now() where id = 1 returning pinged
$$;
