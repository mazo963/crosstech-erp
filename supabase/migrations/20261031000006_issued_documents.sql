-- =====================================================================
-- 帳票の発行（電子帳簿保存法への対応の土台）
--   * 発行した時点の内容を「固定」して残す（見積書・納品書・請求書）。再印刷は固定した内容から行う
--   * 固定した内容・ハッシュは更新も削除もできない。訂正は「取消 + 新しい版の発行」で、旧版は残る
--   * 検索項目（取引年月日・取引金額・取引先）を列として持つ
--   * 交付の記録（紙 / PDFメール / その他）と、送付したPDFそのものの保存
--   法令上の解釈は docs/電帳法対応方針.md を参照（要確認事項を含む）
-- =====================================================================

-- ERPの請求書を「正式な請求書」として扱うか（false = MFが正式で、ERPは控え・社内用）
alter table public.company_settings
  add column erp_invoice_official boolean not null default false;

create table public.issued_documents (
  id                uuid primary key default gen_random_uuid(),
  doc_type          text not null check (doc_type in ('quote','delivery_note','invoice')),
  source_id         uuid not null,                     -- 案件 / 納品 / 請求書 の id
  doc_no            text not null,
  version           integer not null check (version >= 1),
  doc_date          date not null,                     -- 取引年月日（見積日 / 納品日 / 請求日）
  amount            numeric(14,0) not null,            -- 取引金額（帳票に記載の合計。請求書・見積書は税込、納品書は税抜）
  counterparty_id   uuid references public.customers(id),
  counterparty_name text not null,                     -- 取引先（発行時点の名称）
  content           jsonb not null,                    -- 帳票の記載内容（固定）
  content_sha256    text not null,
  voided            boolean not null default false,
  void_reason       text,
  voided_at         timestamptz,
  issued_by         uuid references public.staff(id) default auth.uid(),
  issued_at         timestamptz not null default now(),
  unique (doc_type, source_id, version),
  constraint issued_documents_void_chk check (not voided or coalesce(btrim(void_reason), '') <> '')
);
create index on public.issued_documents (doc_date);
create index on public.issued_documents (amount);
create index on public.issued_documents (counterparty_name);
create index on public.issued_documents (doc_no);

create table public.document_deliveries (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.issued_documents(id),
  method       text not null check (method in ('paper','email_pdf','other')),
  delivered_on date not null default current_date,
  recipient    text,
  note         text,
  created_by   uuid references public.staff(id) default auth.uid(),
  created_at   timestamptz not null default now()
);
create index on public.document_deliveries (document_id);

create table public.document_files (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.issued_documents(id),
  delivery_id  uuid references public.document_deliveries(id),
  file_name    text not null,
  size_bytes   integer not null,
  sha256       text not null,
  data         bytea not null,
  uploaded_by  uuid references public.staff(id) default auth.uid(),
  uploaded_at  timestamptz not null default now()
);
create index on public.document_files (document_id);

-- ---------------------------------------------------------------------
-- 改ざん防止: ハッシュはDBが計算する。固定内容は更新不可。削除不可。取消は false → true のみ
-- ---------------------------------------------------------------------
create function public.tg_issued_documents_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.content_sha256 := encode(sha256(convert_to(new.content::text, 'UTF8')), 'hex');
    new.voided := false; new.void_reason := null; new.voided_at := null;
    return new;
  elsif tg_op = 'DELETE' then
    raise exception '発行済みの帳票は削除できません（取消してください）';
  end if;
  if (to_jsonb(new) - array['voided','void_reason','voided_at']) <> (to_jsonb(old) - array['voided','void_reason','voided_at']) then
    raise exception '発行済みの帳票の内容は変更できません（取消して新しい版を発行してください）';
  end if;
  if old.voided and not new.voided then
    raise exception '取消した帳票は元に戻せません';
  end if;
  return new;
end $$;
create trigger trg_issued_documents_guard before insert or update or delete on public.issued_documents
  for each row execute function public.tg_issued_documents_guard();

-- 交付記録・PDF は追記のみ
create function public.tg_append_only()
returns trigger language plpgsql as $$
begin
  raise exception '% は追記のみです。更新・削除はできません', tg_table_name;
end $$;
create trigger trg_document_deliveries_append_only before update or delete on public.document_deliveries
  for each row execute function public.tg_append_only();
create trigger trg_document_files_append_only before update or delete on public.document_files
  for each row execute function public.tg_append_only();

-- 元の請求書・納品が取消されたら、固定済みの帳票も取消にする（履歴は残す）
create function public.tg_void_invoice_documents()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'void' and old.status <> 'void' then
    update public.issued_documents set voided = true, void_reason = '元の請求書が取消されたため', voided_at = now()
     where doc_type = 'invoice' and source_id = new.id and not voided;
  end if;
  return new;
end $$;
create trigger trg_invoices_void_docs after update on public.invoices
  for each row execute function public.tg_void_invoice_documents();

create function public.tg_void_delivery_documents()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.voided and not old.voided then
    update public.issued_documents set voided = true, void_reason = '元の納品が取消されたため', voided_at = now()
     where doc_type = 'delivery_note' and source_id = new.id and not voided;
  end if;
  return new;
end $$;
create trigger trg_deliveries_void_docs after update on public.deliveries
  for each row execute function public.tg_void_delivery_documents();

-- ---------------------------------------------------------------------
-- 帳票の発行（内容の組み立て・金額・消費税はすべてここ＝DB）
--   同じ内容がすでに有効な最新版なら、新しい版を作らずその id を返す
-- ---------------------------------------------------------------------
create function public.issue_document(p_type text, p_source_id uuid)
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
    select jsonb_agg(jsonb_build_object('product_no', product_no, 'name', name, 'spec', spec, 'quantity', quantity,
             'unit', unit, 'unit_price', sale_unit_price, 'amount', floor(quantity * sale_unit_price), 'due_date', due_date)
             order by line_no),
           coalesce(sum(floor(quantity * sale_unit_price)), 0)
      into v_lines, v_sub from public.project_items where project_id = p_source_id;
    if v_lines is null then raise exception '品目がありません'; end if;
    v_tax := public.round_tax(v_sub * v_set.tax_rate, v_set.tax_rounding);
    v_no := v_proj.project_no; v_date := coalesce(v_proj.estimate_date, current_date); v_amount := v_sub + v_tax;
    v_content := v_head || jsonb_build_object('title', v_proj.title, 'notes', v_proj.notes, 'due_date', v_proj.due_date,
      'lines', v_lines, 'subtotal', v_sub, 'tax_rate', v_set.tax_rate, 'tax', v_tax, 'total', v_sub + v_tax);

  elsif p_type = 'delivery_note' then
    select * into v_dv from public.deliveries where id = p_source_id;
    if not found then raise exception '納品が見つかりません'; end if;
    if v_dv.voided then raise exception '取消された納品の納品書は発行できません'; end if;
    select c.* into v_cust from public.projects p join public.customers c on c.id = p.customer_id where p.id = v_dv.project_id;
    select jsonb_agg(jsonb_build_object('product_no', i.product_no, 'name', i.name, 'spec', i.spec, 'quantity', dl.quantity,
             'unit', i.unit, 'unit_price', dl.unit_price, 'amount', dl.amount) order by i.line_no),
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
    select jsonb_agg(jsonb_build_object('description', description, 'quantity', quantity, 'unit_price', unit_price, 'amount', amount)
             order by description)
      into v_lines from public.invoice_lines where invoice_id = p_source_id;
    v_no := v_inv.invoice_no; v_date := v_inv.issue_date; v_amount := v_inv.total;
    v_content := v_head || jsonb_build_object('official', v_set.erp_invoice_official, 'mf_invoice_no', v_inv.mf_invoice_no,
      'bank_info', v_set.bank_info, 'period_from', v_inv.period_from, 'period_to', v_inv.period_to, 'due_date', v_inv.due_date,
      'lines', v_lines, 'subtotal', v_inv.subtotal,
      'tax_breakdown', jsonb_build_array(jsonb_build_object('rate', v_inv.tax_rate, 'base', v_inv.subtotal, 'tax', v_inv.tax)),
      'tax_rate', v_inv.tax_rate, 'tax', v_inv.tax, 'total', v_inv.total);
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

-- ---------------------------------------------------------------------
-- 送付したPDFの保存（電子取引データ）。ハッシュ・サイズはDBが計算。PDF以外・大きすぎるものは拒否
-- ---------------------------------------------------------------------
create function public.attach_document_pdf(p_document_id uuid, p_delivery_id uuid, p_file_name text, p_base64 text)
returns uuid language plpgsql as $$
declare
  v_data bytea := decode(p_base64, 'base64');
  v_id   uuid;
begin
  if length(v_data) = 0 or length(v_data) > 5 * 1024 * 1024 then raise exception 'PDFのサイズが不正です（5MBまで）'; end if;
  if convert_from(substring(v_data from 1 for 5), 'LATIN1') <> '%PDF-' then raise exception 'PDFファイルではありません'; end if;
  insert into public.document_files (document_id, delivery_id, file_name, size_bytes, sha256, data)
  values (p_document_id, p_delivery_id, p_file_name, length(v_data), encode(sha256(v_data), 'hex'), v_data)
  returning id into v_id;
  return v_id;
end $$;

create function public.document_file_base64(p_file_id uuid)
returns text language sql stable as $$ select encode(data, 'base64') from public.document_files where id = p_file_id $$;

-- ---------------------------------------------------------------------
-- RLS: 閲覧はスタッフ全員、発行・記録は admin / office。更新・削除のポリシーは作らない
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['issued_documents','document_deliveries','document_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke update, delete, truncate on public.%I from authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_staff())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_write())', t || '_insert', t);
  end loop;
end $$;

revoke execute on function public.issue_document(text, uuid), public.attach_document_pdf(uuid, uuid, text, text),
  public.document_file_base64(uuid) from public, anon;
grant  execute on function public.issue_document(text, uuid), public.attach_document_pdf(uuid, uuid, text, text),
  public.document_file_base64(uuid) to authenticated;
