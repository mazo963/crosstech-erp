-- =====================================================================
-- 帳票の記載項目（有効期限・納期・支払条件・振込先・納入場所・客先注文番号・自社ロゴ・自社担当者・FAX・社印）
--   * 既定は、自社情報（company_settings）・振込先口座（bank_accounts）・得意先・案件から取る
--   * doc_options: 帳票（見積書=案件、納品書=納品、請求書=請求書）ごとの変更と、表示する／しないの切替（null = 既定に従う）
--   * resolve_doc_options: 実際に使う値と表示の有無を決める
--   * build_document_content: 従来の組み立て（build_document_core に改名）の結果へ、表示する項目だけを加える
--     （印刷されたものが、そのまま固定される内容になる。非表示の項目は内容に入れない）
-- =====================================================================
alter table public.company_settings
  add column fax              text,
  add column contact_person   text,                  -- 自社の担当者名（帳票の既定）
  add column quote_valid_days smallint not null default 30 check (quote_valid_days between 1 and 365),
  add column logo_data        text,                  -- 自社ロゴ（data URL。PNG/JPEG、約300KBまで）
  add column seal_data        text;                  -- 社印の画像（同上）
alter table public.company_settings
  add constraint company_logo_format check (logo_data is null or (logo_data ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$' and length(logo_data) <= 400000)),
  add constraint company_seal_format check (seal_data is null or (seal_data ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$' and length(seal_data) <= 400000));

alter table public.customers add column default_delivery_place text;   -- 納入場所の既定

-- 振込先口座（複数）。削除せず、使わなくなったら active を外す
create table public.bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,                       -- 画面で選ぶときの名前（例: 〇〇銀行 普通）
  bank_name      text not null,
  branch_name    text,
  account_type   text not null default '普通' check (account_type in ('普通','当座','貯蓄')),
  account_number text not null,
  account_holder text not null,
  is_default     boolean not null default false,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index uq_bank_accounts_default on public.bank_accounts (is_default) where is_default and active;
create trigger trg_bank_accounts_updated before update on public.bank_accounts
  for each row execute function public.tg_set_updated_at();
alter table public.bank_accounts enable row level security;
revoke all on public.bank_accounts from anon;
create policy bank_accounts_select on public.bank_accounts for select to authenticated using (public.is_staff());
create policy bank_accounts_insert on public.bank_accounts for insert to authenticated with check (public.is_admin());
create policy bank_accounts_update on public.bank_accounts for update to authenticated using (public.is_admin()) with check (public.is_admin());

create table public.doc_options (
  doc_type          text not null check (doc_type in ('quote','delivery_note','invoice')),
  source_id         uuid not null,
  valid_until       date,
  delivery_place    text,
  contact_person    text,
  bank_account_id   uuid references public.bank_accounts(id),
  payment_terms     text,
  show_logo           boolean,
  show_seal           boolean,
  show_fax            boolean,
  show_contact        boolean,
  show_valid_until    boolean,
  show_lead_time      boolean,
  show_delivery_place boolean,
  show_po_no          boolean,
  show_bank           boolean,
  show_payment_terms  boolean,
  updated_by        uuid references public.staff(id) default auth.uid(),
  updated_at        timestamptz not null default now(),
  primary key (doc_type, source_id)
);
create trigger trg_doc_options_updated before update on public.doc_options
  for each row execute function public.tg_set_updated_at();
alter table public.doc_options enable row level security;
revoke all on public.doc_options from anon;
create policy doc_options_select on public.doc_options for select to authenticated using (public.is_staff());
create policy doc_options_insert on public.doc_options for insert to authenticated with check (public.can_write());
create policy doc_options_update on public.doc_options for update to authenticated using (public.can_write()) with check (public.can_write());
create policy doc_options_delete on public.doc_options for delete to authenticated using (public.can_write());

-- 得意先の締め・支払条件を、帳票に書く文章にする（例: 末日締め　翌月末日払い）
create function public.payment_terms_text(p_cust public.customers) returns text language sql immutable as $$
  select case when p_cust.closing_day = 0 then '都度' when p_cust.closing_day = 31 then '末日' else p_cust.closing_day || '日' end || '締め　'
      || case p_cust.payment_month_offset when 0 then '当月' when 1 then '翌月' when 2 then '翌々月' else '3か月後' end
      || case when p_cust.payment_day = 0 then '当日' when p_cust.payment_day = 31 then '末日' else p_cust.payment_day || '日' end || '払い'
$$;

create function public.resolve_doc_options(p_type text, p_source_id uuid)
returns jsonb language plpgsql stable as $$
declare
  v_set     public.company_settings;
  v_cust    public.customers;
  v_row     public.doc_options;
  v_proj    public.projects;
  v_project uuid;
  v_place   text;
  v_def     jsonb;
  v_bank    public.bank_accounts;
  v_po      text;
begin
  select * into v_set from public.company_settings where id = 1;
  if p_type = 'quote' then
    select * into v_proj from public.projects where id = p_source_id;
    v_project := p_source_id;
  elsif p_type = 'delivery_note' then
    select p.* into v_proj from public.deliveries d join public.projects p on p.id = d.project_id where d.id = p_source_id;
    v_project := v_proj.id;
  elsif p_type = 'invoice' then
    select case when count(distinct d.project_id) = 1 then (array_agg(distinct d.project_id))[1] end into v_project
      from public.invoice_lines il join public.delivery_lines dl on dl.id = il.delivery_line_id join public.deliveries d on d.id = dl.delivery_id
     where il.invoice_id = p_source_id;                -- 1つの案件だけから成る請求書のみ、案件の客先注文番号を引く
    if v_project is not null then select * into v_proj from public.projects where id = v_project; end if;
    select c.* into v_cust from public.invoices i join public.customers c on c.id = i.customer_id where i.id = p_source_id;
  else
    raise exception '帳票の種類が不正です: %', p_type;
  end if;
  if v_cust.id is null then select * into v_cust from public.customers where id = v_proj.customer_id; end if;
  if v_cust.id is null then raise exception '得意先が見つかりません'; end if;

  select * into v_row from public.doc_options where doc_type = p_type and source_id = p_source_id;
  select * into v_bank from public.bank_accounts where id = coalesce(v_row.bank_account_id, (select id from public.bank_accounts where is_default and active));
  v_po := v_proj.customer_po_no;

  v_def := jsonb_build_object(
    'valid_until', case when v_proj.id is not null then coalesce(v_proj.estimate_date, current_date) + v_set.quote_valid_days end,
    'delivery_place', v_cust.default_delivery_place, 'contact_person', v_set.contact_person,
    'bank_account_id', (select id from public.bank_accounts where is_default and active),
    'payment_terms', public.payment_terms_text(v_cust));

  return jsonb_build_object(
    'source', case when v_row.doc_type is null then 'default' else 'document' end,
    'values', jsonb_build_object(
      'valid_until',     coalesce(v_row.valid_until,    (v_def->>'valid_until')::date),
      'delivery_place',  coalesce(v_row.delivery_place, v_def->>'delivery_place'),
      'contact_person',  coalesce(v_row.contact_person, v_def->>'contact_person'),
      'bank_account_id', v_bank.id,
      'payment_terms',   coalesce(v_row.payment_terms,  v_def->>'payment_terms'),
      'customer_po_no',  v_po,
      'fax',             v_set.fax),
    'show', jsonb_build_object(
      'logo', coalesce(v_row.show_logo, true), 'seal', coalesce(v_row.show_seal, true), 'fax', coalesce(v_row.show_fax, true),
      'contact', coalesce(v_row.show_contact, true), 'valid_until', coalesce(v_row.show_valid_until, true),
      'lead_time', coalesce(v_row.show_lead_time, true), 'delivery_place', coalesce(v_row.show_delivery_place, true),
      'po_no', coalesce(v_row.show_po_no, true), 'bank', coalesce(v_row.show_bank, true),
      'payment_terms', coalesce(v_row.show_payment_terms, true)),
    'defaults', v_def,
    'bank', case when v_bank.id is null then null else jsonb_build_object('bank_name', v_bank.bank_name, 'branch_name', v_bank.branch_name,
      'account_type', v_bank.account_type, 'account_number', v_bank.account_number, 'account_holder', v_bank.account_holder) end,
    'has_logo', v_set.logo_data is not null, 'has_seal', v_set.seal_data is not null);
end $$;

-- 従来の組み立てを build_document_core に改名し、build_document_content は表示する項目を加える
alter function public.build_document_content(text, uuid, boolean) rename to build_document_core;

create function public.build_document_content(p_type text, p_source_id uuid, p_allow_draft boolean default false)
returns jsonb language plpgsql stable as $$
declare
  v    jsonb := public.build_document_core(p_type, p_source_id, p_allow_draft);
  o    jsonb := public.resolve_doc_options(p_type, p_source_id);
  s    jsonb := o->'show';
  val  jsonb := o->'values';
  st   public.company_settings;
  v_issuer jsonb;
begin
  select * into st from public.company_settings where id = 1;
  v_issuer := v->'issuer' || jsonb_build_object(
    'fax',            case when (s->>'fax')::boolean then st.fax end,
    'contact_person', case when (s->>'contact')::boolean then val->>'contact_person' end,
    'logo',           case when (s->>'logo')::boolean then st.logo_data end,
    'seal',           case when (s->>'seal')::boolean then st.seal_data end);
  v := v || jsonb_build_object('issuer', v_issuer);

  if p_type = 'quote' then
    v := v || jsonb_build_object(
      'valid_until', case when (s->>'valid_until')::boolean then val->>'valid_until' end,
      'due_date',    case when (s->>'lead_time')::boolean then v->'due_date' end);
  elsif p_type = 'delivery_note' then
    v := v || jsonb_build_object(
      'delivery_place', case when (s->>'delivery_place')::boolean then val->>'delivery_place' end,
      'customer_po_no', case when (s->>'po_no')::boolean then v->'customer_po_no' end);
  else
    v := v || jsonb_build_object(
      'delivery_place', case when (s->>'delivery_place')::boolean then val->>'delivery_place' end,
      'customer_po_no', case when (s->>'po_no')::boolean then val->'customer_po_no' end,
      'payment_terms',  case when (s->>'payment_terms')::boolean then val->>'payment_terms' end,
      'bank',           case when (s->>'bank')::boolean then o->'bank' end,
      'bank_info',      case when (s->>'bank')::boolean and o->'bank' = 'null'::jsonb then v->'bank_info' end);
  end if;
  return v;
end $$;

revoke execute on function public.resolve_doc_options(text, uuid), public.build_document_core(text, uuid, boolean),
  public.build_document_content(text, uuid, boolean), public.payment_terms_text(public.customers) from public, anon;
grant execute on function public.resolve_doc_options(text, uuid), public.build_document_core(text, uuid, boolean), public.build_document_content(text, uuid, boolean),
  public.payment_terms_text(public.customers) to authenticated;
