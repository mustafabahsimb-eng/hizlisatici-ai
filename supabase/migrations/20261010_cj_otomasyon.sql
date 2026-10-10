-- =========================================================
-- Seltigo - CJ otomatik sipariş + kargo takibi + WhatsApp kargo bildirimi
-- Kararlar (2026-10-10):
--  * Tedarikçi siparişi kendiliğinden CJ'ye gider; ödeme varsayılan OTOMATİK (CJ bakiyesi).
--  * Zarar kontrolü her zaman çalışır: zararlı sipariş ödenmez, satıcı onayına düşer.
--  * Bakiye yetmezse sipariş bekler, satıcıya uyarı çıkar, bakiye gelince otomatik ödenir.
--  * Müşteri takip sayfası her zaman var; WhatsApp bağlıysa ve şablon onaylıysa
--    kargo numarası gelince müşteriye otomatik mesaj gider (satıcı kapatabilir).
-- =========================================================

-- ---------- 1) Mağaza siparişi: adet, fiyat, düzgün adres, takip ----------
alter table public.store_orders
  add column if not exists quantity integer not null default 1,
  add column if not exists unit_price numeric,
  add column if not exists currency text,
  add column if not exists listing_id uuid,
  add column if not exists variant_id uuid,
  add column if not exists customer_city text,
  add column if not exists customer_district text,
  add column if not exists customer_zip text,
  add column if not exists customer_country text not null default 'TR',
  add column if not exists tracking_token text,
  add column if not exists tracking_number text,
  add column if not exists tracking_carrier text,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists whatsapp_notified_at timestamptz;

update public.store_orders
  set tracking_token = encode(extensions.gen_random_bytes(12), 'hex')
  where tracking_token is null;

alter table public.store_orders
  alter column tracking_token set default encode(extensions.gen_random_bytes(12), 'hex'),
  alter column tracking_token set not null;

create unique index if not exists store_orders_tracking_token_key on public.store_orders (tracking_token);

-- ---------- 2) Tedarikçi siparişi: maliyet, deneme, bekleme sebebi ----------
alter table public.orders
  add column if not exists store_order_id uuid references public.store_orders(id) on delete set null,
  add column if not exists unit_price numeric,
  add column if not exists currency text,
  add column if not exists customer_district text,
  add column if not exists customer_zip text,
  add column if not exists customer_country text not null default 'TR',
  add column if not exists supplier_shipment_id text,
  add column if not exists cost_usd numeric,
  add column if not exists cost_local numeric,
  add column if not exists hold_reason text,
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists paid_at timestamptz;

create index if not exists orders_worker_idx on public.orders (status, next_attempt_at) where supplier = 'cj';

-- ---------- 3) Satıcı ayarları (varsayılanlar: otomatik ödeme AÇIK, WhatsApp bildirimi AÇIK) ----------
alter table public.user_profiles
  add column if not exists cj_auto_pay boolean not null default true,
  add column if not exists wa_tracking_notify boolean not null default true;

-- ---------- 4) WhatsApp mesaj şablonları (her satıcının WhatsApp hesabı için ayrı) ----------
create table if not exists public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id uuid not null references public.social_channels(id) on delete cascade,
  waba_id text not null,
  name text not null,
  language text not null default 'tr',
  status text not null default 'NOT_SUBMITTED',
  meta_template_id text,
  reason text,
  submitted_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, name, language)
);

alter table public.whatsapp_templates enable row level security;

drop policy if exists own_templates_select on public.whatsapp_templates;
create policy own_templates_select on public.whatsapp_templates
  for select to authenticated using (user_id = auth.uid());

-- ---------- 5) Mağaza siparişi -> tedarikçi siparişi (yeni alanlarla) ----------
create or replace function public.store_order_to_supplier_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier text;
begin
  select p.supplier into v_supplier
  from public.products p
  where p.id = new.product_id;

  -- Sadece tedarikçisi belli olan (dropshipping) ürünler için
  if v_supplier is null or v_supplier = '' then
    return new;
  end if;

  -- Aynı mağaza siparişi için ikinci kez oluşturma
  if exists (
    select 1 from public.orders o
    where o.user_id = new.user_id
      and (o.store_order_id = new.id or o.marketplace_order_no = 'store-' || new.id::text)
  ) then
    return new;
  end if;

  insert into public.orders (
    user_id, product_id, platform, marketplace_order_no, store_order_id,
    customer_name, customer_phone, customer_address, customer_city,
    customer_district, customer_zip, customer_country,
    quantity, unit_price, currency, supplier, status, note
  ) values (
    new.user_id, new.product_id, 'own_store', 'store-' || new.id::text, new.id,
    new.customer_name, new.customer_phone, new.customer_address, new.customer_city,
    new.customer_district, new.customer_zip, coalesce(new.customer_country, 'TR'),
    greatest(1, least(99, coalesce(new.quantity, 1))), new.unit_price, new.currency,
    v_supplier, 'beklemede',
    '🏪 Mağaza siparişinden otomatik hazırlandı'
  );

  return new;
exception when others then
  -- Tedarikçi siparişi hazırlanamasa bile müşterinin siparişi kaybolmasın
  raise warning 'store_order_to_supplier_order: %', sqlerrm;
  return new;
end;
$$;

-- ---------- 6) Müşteri takip sayfası (giriş gerektirmez; tahmin edilemez anahtarla) ----------
create or replace function public.get_order_tracking(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'store_name', coalesce(ss.store_name, ss.business_name),
    'store_slug', ss.store_slug,
    'product_name', coalesce(p.generated_title, p.name),
    'quantity', so.quantity,
    'status', coalesce(o.status, so.status),
    'tracking_number', coalesce(so.tracking_number, o.tracking_number),
    'tracking_carrier', coalesce(so.tracking_carrier, o.tracking_carrier),
    'created_at', so.created_at,
    'shipped_at', so.shipped_at,
    'delivered_at', so.delivered_at
  )
  from public.store_orders so
  left join public.store_settings ss on ss.user_id = so.user_id
  left join public.products p on p.id = so.product_id
  left join lateral (
    select status, tracking_number, tracking_carrier
    from public.orders where store_order_id = so.id
    order by created_at desc limit 1
  ) o on true
  where length(p_token) >= 20 and so.tracking_token = p_token
  limit 1;
$$;

revoke all on function public.get_order_tracking(text) from public;
grant execute on function public.get_order_tracking(text) to anon, authenticated;

-- ---------- 7) Mağaza siparişi -> satış listesi (adet/fiyat artık ayrı alanlardan) ----------
create or replace function public.store_order_to_marketplace_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing  uuid;
  v_price    numeric;
  v_cur      text;
  v_variant  uuid;
  v_qty      integer;
  v_status   text;
  v_s        text := lower(coalesce(new.status::text, ''));
begin
  if new.user_id is null then
    return new;
  end if;

  -- Kendi Mağazam ilanı
  select l.id, l.price, l.currency
    into v_listing, v_price, v_cur
  from public.listings l
  where l.marketplace_code = 'own_store'
    and l.deleted_at is null
    and l.product_id = (select coalesce(p.merged_into, p.id)
                        from public.products p where p.id = new.product_id)
  limit 1;

  if new.unit_price is not null then
    v_price := new.unit_price;
    v_cur := coalesce(new.currency, v_cur);
  end if;

  if v_price is null then
    select sale_price, cost_currency into v_price, v_cur
    from public.products where id = new.product_id;
  end if;

  select coalesce(new.variant_id, v.id) into v_variant
  from public.product_variants v
  where v.product_id = new.product_id and v.is_default
  limit 1;
  v_variant := coalesce(new.variant_id, v_variant);

  -- Adet: yeni siparişlerde ayrı alanda; eski siparişlerde adres metninde
  v_qty := greatest(
    coalesce(new.quantity, 1),
    coalesce(nullif(substring(lower(coalesce(new.customer_address, '')) from 'adet[^0-9]{0,10}([0-9]{1,4})'), '')::integer, 1)
  );

  v_status := case
    when v_s like '%iptal%'  or v_s like '%cancel%'  then 'cancelled'
    when v_s like '%teslim%' or v_s like '%deliver%' then 'delivered'
    when v_s like '%kargo%'  or v_s like '%ship%'    then 'shipped'
    else 'new'
  end;

  insert into public.marketplace_orders
    (user_id, marketplace_code, external_order_id, listing_id, product_id, variant_id,
     quantity, currency, item_price, vat_payer, status, ordered_at,
     buyer_name, buyer_phone, buyer_address, raw, source_table, source_id)
  values
    (new.user_id, 'own_store', 'store-' || new.id::text, v_listing, new.product_id, v_variant,
     greatest(v_qty, 1), coalesce(v_cur, 'TRY'), v_price, 'seller', v_status,
     coalesce(new.created_at, now()),
     new.customer_name, new.customer_phone,
     jsonb_strip_nulls(jsonb_build_object(
       'text', new.customer_address,
       'city', new.customer_city,
       'district', new.customer_district,
       'zip', new.customer_zip,
       'country', new.customer_country)),
     to_jsonb(new) - 'tracking_token', 'store_orders', new.id::text)
  on conflict (user_id, marketplace_code, external_order_id)
  do update set
    status = excluded.status,
    raw    = excluded.raw
  where public.marketplace_orders.source_table = 'store_orders';

  return new;
end;
$$;
