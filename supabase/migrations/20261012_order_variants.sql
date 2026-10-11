-- Vitrinde seçenek (beden/renk) seçimi: seçilen seçenek mağaza siparişinden tedarikçi siparişine geçer.
-- store_orders.variant_id zaten vardı (20261010_cj_otomasyon); okunur etiket ve orders tarafı eklenir.

alter table public.store_orders
  add column if not exists variant_label text;          -- ör. "Beden: 38 · Renk: Siyah"

alter table public.orders
  add column if not exists variant_id uuid references public.product_variants(id) on delete set null,
  add column if not exists variant_label text;

-- Mağaza siparişi -> tedarikçi siparişi (seçenek dahil)
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
    quantity, unit_price, currency, supplier, status, note,
    variant_id, variant_label
  ) values (
    new.user_id, new.product_id, 'own_store', 'store-' || new.id::text, new.id,
    new.customer_name, new.customer_phone, new.customer_address, new.customer_city,
    new.customer_district, new.customer_zip, coalesce(new.customer_country, 'TR'),
    greatest(1, least(99, coalesce(new.quantity, 1))), new.unit_price, new.currency,
    v_supplier, 'beklemede',
    '🏪 Mağaza siparişinden otomatik hazırlandı',
    new.variant_id, new.variant_label
  );

  return new;
exception when others then
  -- Tedarikçi siparişi hazırlanamasa bile müşterinin siparişi kaybolmasın
  raise warning 'store_order_to_supplier_order: %', sqlerrm;
  return new;
end;
$$;

-- Müşteri takip sayfası: seçilen seçenek de görünsün
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
    'variant_label', so.variant_label,
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
