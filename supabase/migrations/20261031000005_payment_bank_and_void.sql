-- =====================================================================
-- 入金: 入金銀行・口座番号の記録、入金の取消（削除せず voided で残す）
--   * 取消した入金は残高・消込から除外する（消込の履歴行は残る）
--   * 銀行振込（method='bank'）は入金銀行と口座番号が必須。登録は record_payment 経由
-- =====================================================================

alter table public.payments
  add column bank_name   text,
  add column account_no  text,
  add column voided      boolean not null default false,
  add column void_reason text,
  add column voided_at   timestamptz,
  add column voided_by   uuid references public.staff(id),
  add constraint payments_void_reason_chk check (not voided or coalesce(btrim(void_reason), '') <> '');

-- 請求書ごとの残高: 取消済みの入金による消込は数えない
create or replace view public.v_invoice_balance with (security_invoker = true) as
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
  select sum(a.amount) as allocated
    from public.payment_allocations a
    join public.payments p on p.id = a.payment_id and not p.voided
   where a.invoice_id = inv.id
) pa on true;

-- 得意先ごとの残高: 取消済みの入金は除外
create or replace view public.v_customer_balance with (security_invoker = true) as
select
  c.id as customer_id, c.name as customer_name,
  coalesce((select sum(balance) from public.v_invoice_balance b where b.customer_id = c.id), 0) as ar_balance,
  coalesce((select sum(p.amount + p.fee) from public.payments p where p.customer_id = c.id and not p.voided), 0)
  - coalesce((select sum(pa.amount) from public.payment_allocations pa
               join public.payments p on p.id = pa.payment_id and not p.voided
              where p.customer_id = c.id), 0)
    as unallocated_payment,
  coalesce((select sum(amount) from public.v_unbilled_lines u where u.customer_id = c.id), 0) as unbilled_amount
from public.customers c;

-- 入金の記録（引数追加のため作り直す）
drop function public.record_payment(uuid, date, numeric, numeric, text, text);
create function public.record_payment(
  p_customer_id uuid,
  p_received_on date,
  p_amount      numeric,
  p_fee         numeric default 0,
  p_method      text default 'bank',
  p_memo        text default null,
  p_bank_name   text default null,
  p_account_no  text default null
) returns uuid language plpgsql as $$
declare
  v_id     uuid;
  v_left   numeric := p_amount + coalesce(p_fee, 0);
  v_inv    record;
  v_take   numeric;
begin
  if p_method = 'bank' and (coalesce(btrim(p_bank_name), '') = '' or coalesce(btrim(p_account_no), '') = '') then
    raise exception '銀行振込の入金には、入金銀行と口座番号が必要です';
  end if;

  insert into public.payments (customer_id, received_on, amount, fee, method, memo, bank_name, account_no)
  values (p_customer_id, p_received_on, p_amount, coalesce(p_fee, 0), p_method, p_memo,
          nullif(btrim(p_bank_name), ''), nullif(btrim(p_account_no), ''))
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

-- 入金の取消: 理由必須。消込は外れ、請求書の残高が元に戻る。入金の行は残す
create function public.void_payment(p_payment_id uuid, p_reason text)
returns void language plpgsql as $$
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception '取消理由を入力してください'; end if;
  if exists (select 1 from public.payments where id = p_payment_id and voided) then
    raise exception 'この入金はすでに取消済みです';
  end if;
  update public.payments
     set voided = true, void_reason = btrim(p_reason), voided_at = now(), voided_by = auth.uid()
   where id = p_payment_id and not voided;
  if not found then raise exception '入金が見つからないか、取消の権限がありません'; end if;
end $$;

-- 請求書の取消: 有効な（取消されていない）入金の消込があるときだけ拒否する
create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void language plpgsql as $$
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception '取消理由を入力してください'; end if;
  if exists (
    select 1 from public.payment_allocations a
      join public.payments p on p.id = a.payment_id and not p.voided
     where a.invoice_id = p_invoice_id
  ) then
    raise exception '入金消込済みの請求書は取消できません。先に入金を取消してください';
  end if;
  update public.invoices
     set status = 'void', notes = coalesce(notes || E'\n', '') || '取消理由: ' || p_reason
   where id = p_invoice_id and status <> 'void';
end $$;

-- 新しい関数は認証なし（anon）で呼べないようにする
revoke execute on function public.record_payment(uuid, date, numeric, numeric, text, text, text, text) from public, anon;
revoke execute on function public.void_payment(uuid, text) from public, anon;
grant  execute on function public.record_payment(uuid, date, numeric, numeric, text, text, text, text) to authenticated;
grant  execute on function public.void_payment(uuid, text) to authenticated;
