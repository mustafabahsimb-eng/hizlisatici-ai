-- Ürün kaynağı kuralı (Mustafa, 12 Ekim 2026):
-- products.supplier: 'aliexpress' | 'cj' -> sipariş tedarikçiye otomatik gider;
--                    'wholesaler' (Toptancı) | boş (Kendi stoğum) -> satıcı kendisi gönderir; 'printify' ayrı akış.
-- Linkten / dosyadan gelen her ürün varsayılan "Kendi stoğum"; AliExpress linkinde satıcıya sorulur.

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

  -- Ürün kaynağı kuralı: yalnız AliExpress / CJ kaynaklı ürünlerin siparişi tedarikçiye gider.
  -- "Kendi stoğum" (boş), "Toptancı" (wholesaler) ve diğerleri satıcının kendisi tarafından gönderilir.
  if v_supplier is null or v_supplier not in ('aliexpress', 'cj') then
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
