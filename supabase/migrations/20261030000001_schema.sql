-- =====================================================================
-- CROSSTECH ERP  スキーマ定義（テーブル）
-- 金額は numeric(14,0)（円・整数）、単価のみ numeric(14,2) を許可
-- 削除は原則しない（active=false / voided=true で論理削除）
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 共通: updated_at 自動更新
-- ---------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 自社情報（1行のみ）
-- ---------------------------------------------------------------------
create table public.company_settings (
  id              smallint primary key default 1 check (id = 1),
  company_name    text not null default '株式会社クロステック',
  invoice_reg_no  text check (invoice_reg_no ~ '^T[0-9]{13}$'),
  postal_code     text,
  address         text,
  tel             text,
  email           text,
  bank_info       text,                      -- 振込先（請求書に印字）
  tax_rate        numeric(4,3) not null default 0.10,
  tax_rounding    text not null default 'floor'
                  check (tax_rounding in ('floor','round','ceil')),
  updated_at      timestamptz not null default now()
);
insert into public.company_settings (id) values (1);
create trigger trg_company_settings_updated before update on public.company_settings
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- スタッフ（Supabase Auth のユーザーに紐づく）
-- worker_code は受注システムの操作者コードと共通: home / matsuda / other
-- ---------------------------------------------------------------------
create table public.staff (
  id           uuid primary key references auth.users(id) on delete restrict,
  name         text not null,
  role         text not null default 'office' check (role in ('admin','office','viewer')),
  worker_code  text not null default 'other' check (worker_code in ('home','matsuda','other')),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_staff_updated before update on public.staff
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 得意先
--   closing_day : 0=都度, 5/10/15/20/25, 31=末日
--   payment_month_offset : 0=当月, 1=翌月, 2=翌々月
--   payment_day : 0=当日(締め日と同日), 5/10/15/20/25, 31=末日
--   billing_basis : per_delivery=都度納品 / on_completion=全数完納
-- ---------------------------------------------------------------------
create table public.customers (
  id                    uuid primary key default gen_random_uuid(),
  code                  text unique,
  name                  text not null,
  name_kana             text,
  contact_name          text,
  postal_code           text,
  address               text,
  tel                   text,
  invoice_reg_no        text check (invoice_reg_no is null or invoice_reg_no ~ '^T[0-9]{13}$'),
  closing_day           smallint not null default 31
                        check (closing_day in (0,5,10,15,20,25,31)),
  payment_month_offset  smallint not null default 1 check (payment_month_offset between 0 and 3),
  payment_day           smallint not null default 31
                        check (payment_day in (0,5,10,15,20,25,31)),
  billing_basis         text not null default 'per_delivery'
                        check (billing_basis in ('per_delivery','on_completion')),
  invoice_mail_to       text,
  invoice_mail_cc       text,
  delivery_mail_to      text,
  delivery_mail_cc      text,
  notes                 text,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_customers_updated before update on public.customers
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 外注先
-- ---------------------------------------------------------------------
create table public.vendors (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_name  text,
  tel           text,
  email         text,
  closing_day   smallint not null default 31 check (closing_day in (0,5,10,15,20,25,31)),
  process_types text,                         -- 例: 表面処理, 熱処理, 追加工
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_vendors_updated before update on public.vendors
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 採番カウンタ（帳票番号）
-- ---------------------------------------------------------------------
create table public.doc_counters (
  prefix   text not null,       -- PJ / DN / INV
  yymm     text not null,       -- 2610
  last_no  integer not null default 0,
  primary key (prefix, yymm)
);

-- ---------------------------------------------------------------------
-- 案件（見積〜受注の単位）
--   status は「人が決める状態」のみ保持。納品・請求の進捗はビューで算出する
-- ---------------------------------------------------------------------
create table public.projects (
  id              uuid primary key default gen_random_uuid(),
  project_no      text not null unique,
  customer_id     uuid not null references public.customers(id),
  lead_staff_id   uuid references public.staff(id),
  title           text not null,
  customer_po_no  text,                     -- 客先注文番号
  status          text not null default 'estimate'
                  check (status in ('estimate','ordered','lost','closed')),
  estimate_date   date,
  order_date      date,
  due_date        date,
  notes           text,                     -- 帳票の備考欄に印字
  internal_memo   text,                     -- 社内のみ（帳票に出さない）
  source          text not null default 'manual' check (source in ('manual','ai')),
  created_by      uuid references public.staff(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on public.projects (customer_id);
create index on public.projects (status);
create trigger trg_projects_updated before update on public.projects
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 品目（製番単位）
--   product_no = 社内製番（全システム共通キー。例: CRO261001-3）
--   vendor_id が null なら自社加工
--   juchu_* は受注・生産管理システムから同期した値（ERPでは編集しない）
-- ---------------------------------------------------------------------
create table public.project_items (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  line_no            smallint not null,
  product_no         text unique,
  customer_part_no   text,
  name               text not null,
  spec               text,
  vendor_id          uuid references public.vendors(id),
  quantity           numeric(12,2) not null check (quantity > 0),
  unit               text not null default '個',
  cost_unit_price    numeric(14,2) not null default 0 check (cost_unit_price >= 0),
  sale_unit_price    numeric(14,2) not null default 0 check (sale_unit_price >= 0),
  due_date           date,
  juchu_completed_at timestamptz,
  juchu_shipped_date date,
  juchu_synced_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (project_id, line_no)
);
create index on public.project_items (project_id);
create trigger trg_items_updated before update on public.project_items
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- 納品（分納1回 = 1行）。取消は voided=true（請求済みは取消不可）
-- ---------------------------------------------------------------------
create table public.deliveries (
  id            uuid primary key default gen_random_uuid(),
  delivery_no   text not null unique,
  project_id    uuid not null references public.projects(id),
  delivered_on  date not null default current_date,
  notes         text,
  voided        boolean not null default false,
  void_reason   text,
  created_by    uuid references public.staff(id) default auth.uid(),
  created_at    timestamptz not null default now()
);
create index on public.deliveries (project_id);

create table public.delivery_lines (
  id               uuid primary key default gen_random_uuid(),
  delivery_id      uuid not null references public.deliveries(id) on delete cascade,
  project_item_id  uuid not null references public.project_items(id),
  quantity         numeric(12,2) not null check (quantity > 0),
  unit_price       numeric(14,2) not null,       -- 納品時点の売単価を固定
  amount           numeric(14,0) not null,       -- 行金額（円未満切捨て）
  unique (delivery_id, project_item_id)
);
create index on public.delivery_lines (project_item_id);

-- ---------------------------------------------------------------------
-- 請求（締め請求: 得意先×締め期間で1枚）
--   消費税は「請求書1枚・税率ごとに1回」端数処理（インボイス要件）
--   mf_invoice_no: MF併用期間に、MF側で発行した正式番号を控える
-- ---------------------------------------------------------------------
create table public.invoices (
  id             uuid primary key default gen_random_uuid(),
  invoice_no     text not null unique,
  customer_id    uuid not null references public.customers(id),
  period_from    date,
  period_to      date not null,
  issue_date     date not null default current_date,
  due_date       date,
  subtotal       numeric(14,0) not null default 0,
  tax_rate       numeric(4,3) not null,
  tax            numeric(14,0) not null default 0,
  total          numeric(14,0) not null default 0,
  status         text not null default 'draft' check (status in ('draft','issued','void')),
  mf_invoice_no  text,
  notes          text,
  issued_by      uuid references public.staff(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on public.invoices (customer_id);
create trigger trg_invoices_updated before update on public.invoices
  for each row execute function public.tg_set_updated_at();

create table public.invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.invoices(id) on delete cascade,
  delivery_line_id  uuid references public.delivery_lines(id),
  description       text not null,
  quantity          numeric(12,2) not null,
  unit_price        numeric(14,2) not null,
  amount            numeric(14,0) not null
);
create index on public.invoice_lines (invoice_id);
-- 同じ納品行を二重請求しない（取消済み請求は除外するため部分インデックスは関数側で担保）
create index on public.invoice_lines (delivery_line_id);

-- ---------------------------------------------------------------------
-- 入金と消込
-- ---------------------------------------------------------------------
create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id),
  received_on  date not null,
  amount       numeric(14,0) not null check (amount > 0),
  fee          numeric(14,0) not null default 0 check (fee >= 0),   -- 振込手数料（先方負担差引）
  method       text not null default 'bank' check (method in ('bank','cash','offset','other')),
  memo         text,
  created_by   uuid references public.staff(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

create table public.payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references public.payments(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id),
  amount      numeric(14,0) not null check (amount > 0),
  unique (payment_id, invoice_id)
);

-- ---------------------------------------------------------------------
-- 外注仕入（外注先からの請求・支払）
-- ---------------------------------------------------------------------
create table public.purchases (
  id                 uuid primary key default gen_random_uuid(),
  vendor_id          uuid not null references public.vendors(id),
  project_item_id    uuid references public.project_items(id),
  purchased_on       date not null default current_date,
  description        text not null,
  quantity           numeric(12,2) not null default 1,
  unit_price         numeric(14,2) not null default 0,
  amount             numeric(14,0) not null,
  vendor_invoice_no  text,
  paid_on            date,
  created_by         uuid references public.staff(id) default auth.uid(),
  created_at         timestamptz not null default now()
);
create index on public.purchases (vendor_id);

-- ---------------------------------------------------------------------
-- AI取込ログ（コスト管理・精度確認用）
-- ---------------------------------------------------------------------
create table public.ai_extractions (
  id                  uuid primary key default gen_random_uuid(),
  source_type         text not null check (source_type in ('email','po_pdf','other')),
  model               text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  status              text not null check (status in ('ok','error','rejected')),
  result              jsonb,
  error_message       text,
  applied_project_id  uuid references public.projects(id),
  created_by          uuid references public.staff(id) default auth.uid(),
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 操作ログ（金額・状態の変更を追跡）
-- ---------------------------------------------------------------------
create table public.audit_log (
  id          bigserial primary key,
  table_name  text not null,
  record_id   text not null,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb,
  actor       uuid default auth.uid(),
  at          timestamptz not null default now()
);

create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (table_name, record_id, action, old_data, new_data)
  values (
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then old.id else new.id end)::text, ''),
    tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

create trigger trg_audit_projects      after insert or update or delete on public.projects       for each row execute function public.tg_audit();
create trigger trg_audit_items         after insert or update or delete on public.project_items  for each row execute function public.tg_audit();
create trigger trg_audit_deliveries    after insert or update or delete on public.deliveries     for each row execute function public.tg_audit();
create trigger trg_audit_invoices      after insert or update or delete on public.invoices       for each row execute function public.tg_audit();
create trigger trg_audit_payments      after insert or update or delete on public.payments       for each row execute function public.tg_audit();
create trigger trg_audit_purchases     after insert or update or delete on public.purchases      for each row execute function public.tg_audit();
create trigger trg_audit_customers     after insert or update or delete on public.customers      for each row execute function public.tg_audit();

-- 疎通確認・無料プランの休止防止用（GitHub Actions から毎日呼ぶ）
create table public.keepalive (
  id      smallint primary key default 1 check (id = 1),
  pinged  timestamptz not null default now()
);
insert into public.keepalive (id) values (1);
