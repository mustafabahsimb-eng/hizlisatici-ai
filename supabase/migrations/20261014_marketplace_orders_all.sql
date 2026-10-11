-- =========================================================
-- Tüm pazaryeri siparişleri (marketplace-orders işçisi + amazon-orders) için tetikleyiciler
-- 1) Tedarikçi siparişi: AliExpress / CJ ürünü, HER pazaryerinden (Kendi Mağazam hariç; o store_orders tetikleyicisinde)
-- 2) Gönderi / etiket: satıcının kendi gönderdiği ürün ve kargoyu pazaryeri AYARLAMIYORSA (Shopify, WooCommerce, Etsy, eBay, Walmart, Wix)
--    -> varsayılan kargo hesabıyla. Trendyol / Hepsiburada / n11 / Çiçeksepeti / Pazarama kargoyu kendisi ayarlar (raw.marketplaceShips).
--    Amazon: kargo hesabı yoksa Buy Shipping (önceki kural korunur).
-- =========================================================
create or replace function public.marketplace_order_to_supplier_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_supplier text;
begin
  if new.marketplace_code = 'own_store' or new.product_id is null or new.status <> 'new' then return new; end if;
  select supplier into v_supplier from public.products where id = new.product_id;
  if v_supplier is null or v_supplier not in ('aliexpress', 'cj') then return new; end if;
  if not public.feature_enabled(new.user_id, 'supplier_autoorder') then return new; end if;
  if exists (select 1 from public.orders o where o.user_id = new.user_id and o.marketplace_order_no = new.external_order_id and o.product_id = new.product_id) then return new; end if;
  insert into public.orders (user_id, product_id, platform, marketplace_order_no, customer_name, customer_phone, customer_address, customer_city,
    customer_district, customer_zip, customer_country, quantity, unit_price, currency, supplier, status, hold_reason, note, variant_id)
  values (new.user_id, new.product_id, new.marketplace_code, new.external_order_id, new.buyer_name, new.buyer_phone,
    concat_ws(' ', new.buyer_address->>'line1', new.buyer_address->>'line2', new.buyer_address->>'line3'), new.buyer_address->>'city',
    new.buyer_address->>'district', new.buyer_address->>'zip', coalesce(nullif(new.buyer_country::text, ''), nullif(new.buyer_address->>'country', ''), 'TR'),
    greatest(1, least(99, new.quantity)), new.item_price, new.currency, v_supplier,
    case when coalesce(new.buyer_address->>'line1', '') = '' then 'onay_bekliyor' else 'beklemede' end,
    case when coalesce(new.buyer_address->>'line1', '') = '' then 'adres_yok' end,
    case when coalesce(new.buyer_address->>'line1', '') = '' then '🟡 Pazaryeri alıcı adresi gelmedi' else '🟡 ' || new.marketplace_code || ' siparişinden otomatik hazırlandı' end,
    new.variant_id);
  return new;
exception when others then
  raise warning 'marketplace_order_to_supplier_order: %', sqlerrm;
  return new;
end $$;

create or replace function public.marketplace_order_to_shipment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_supplier text; v_auto boolean; v_acc record; v_buy text;
begin
  if new.marketplace_code = 'own_store' or new.status <> 'new' or new.product_id is null then return new; end if;
  if coalesce(new.raw->>'marketplaceShips', 'false') = 'true' then return new; end if;   -- kargoyu pazaryeri ayarlıyor
  if coalesce(new.buyer_address->>'line1', '') = '' then return new; end if;
  select supplier into v_supplier from public.products where id = new.product_id;
  if v_supplier in ('aliexpress', 'cj', 'printify') then return new; end if;
  if not public.feature_enabled(new.user_id, 'shipping_labels') then return new; end if;
  select coalesce(shipping_auto, true) into v_auto from public.user_profiles where user_id = new.user_id;
  if v_auto is false then return new; end if;
  select id, provider, mode into v_acc from public.shipping_accounts where user_id = new.user_id and is_default and status = 'connected' limit 1;
  if v_acc.id is not null then
    insert into public.shipments (user_id, marketplace_order_id, account_id, provider, test)
    values (new.user_id, new.id, v_acc.id, v_acc.provider, v_acc.mode = 'test') on conflict do nothing;
    return new;
  end if;
  if new.marketplace_code in ('amazon_us', 'amazon_ca', 'amazon_uk', 'amazon_de', 'amazon_fr', 'amazon_it', 'amazon_es', 'amazon_jp', 'amazon_au') then
    select settings->>'buy_shipping' into v_buy from public.store_connections where id = new.connection_id;
    if coalesce(v_buy, 'true') <> 'false' then
      insert into public.shipments (user_id, marketplace_order_id, account_id, provider, test)
      values (new.user_id, new.id, null, 'amazon', false) on conflict do nothing;
    end if;
  end if;
  return new;
exception when others then
  raise warning 'marketplace_order_to_shipment: %', sqlerrm;
  return new;
end $$;
