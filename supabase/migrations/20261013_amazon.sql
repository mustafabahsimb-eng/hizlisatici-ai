-- =========================================================
-- Amazon SP-API (TR + Global): bağlantı durumu, ürün türü önbelleği, eksik pazarlar, sipariş eşleme
-- =========================================================

-- Bağlanma isteği (CSRF "state"): 10 dk geçerli, tek kullanımlık; yalnız sunucu okur
create table if not exists public.amazon_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  connect_region text not null check (connect_region in ('tr', 'eu', 'na', 'fe')),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.amazon_oauth_states enable row level security;

-- Ürün türü şeması önbelleği (her pazarda bir kez çekilir; 14 gün geçerli). Herkese ortak, kişisel veri yok.
create table if not exists public.amazon_product_types (
  marketplace_id text not null,
  product_type text not null,
  required text[] not null default '{}',
  properties jsonb not null default '{}'::jsonb,
  themes text[] not null default '{}',
  fetched_at timestamptz not null default now(),
  primary key (marketplace_id, product_type)
);
alter table public.amazon_product_types enable row level security;

-- Eksik ülkeler (Amazon pazarlarının ülkeleri; AB üyelerinde pazaryeri KDV eşiği 150 EUR - IOSS)
insert into public.countries (code, name_tr, name_en, currency, default_language, eu_member, marketplace_vat_threshold, marketplace_vat_threshold_currency)
values
  ('ES', 'İspanya', 'Spain', 'EUR', 'es', true, 150, 'EUR'),
  ('SE', 'İsveç', 'Sweden', 'SEK', 'sv', true, 150, 'EUR'),
  ('BE', 'Belçika', 'Belgium', 'EUR', 'fr', true, 150, 'EUR'),
  ('AE', 'Birleşik Arap Emirlikleri', 'United Arab Emirates', 'AED', 'en', false, null, null),
  ('SA', 'Suudi Arabistan', 'Saudi Arabia', 'SAR', 'en', false, null, null),
  ('EG', 'Mısır', 'Egypt', 'EGP', 'en', false, null, null),
  ('IN', 'Hindistan', 'India', 'INR', 'en', false, null, null),
  ('ZA', 'Güney Afrika', 'South Africa', 'ZAR', 'en', false, null, null),
  ('MX', 'Meksika', 'Mexico', 'MXN', 'es', false, null, null),
  ('BR', 'Brezilya', 'Brazil', 'BRL', 'pt', false, null, null),
  ('JP', 'Japonya', 'Japan', 'JPY', 'ja', false, null, null),
  ('AU', 'Avustralya', 'Australia', 'AUD', 'en', false, null, null),
  ('SG', 'Singapur', 'Singapore', 'SGD', 'en', false, null, null)
on conflict (code) do nothing;

-- Eksik Amazon pazarları (kurallar Amazon Almanya satırından kopyalanır)
insert into public.marketplaces (code, name, country_code, currency, language, default_commission_pct, commission_is_approximate, requires_ean, requires_gpsr,
  supports_variants, vat_collected_by_marketplace, max_title_length, max_images, price_rounding, test_mode, api_sandbox_url, api_live_url, is_active)
select v.code, v.name, v.cc, v.cur, v.lang, d.default_commission_pct, true, d.requires_ean, v.gpsr, d.supports_variants, d.vat_collected_by_marketplace,
  d.max_title_length, d.max_images, d.price_rounding, d.test_mode, v.sandbox, v.live, d.is_active
from (values
  ('amazon_es', 'Amazon İspanya', 'ES', 'EUR', 'es', true, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_se', 'Amazon İsveç', 'SE', 'SEK', 'sv', true, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_be', 'Amazon Belçika', 'BE', 'EUR', 'fr', true, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_ie', 'Amazon İrlanda', 'IE', 'EUR', 'en', true, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_ae', 'Amazon BAE', 'AE', 'AED', 'en', false, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_sa', 'Amazon Suudi Arabistan', 'SA', 'SAR', 'en', false, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_eg', 'Amazon Mısır', 'EG', 'EGP', 'en', false, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_in', 'Amazon Hindistan', 'IN', 'INR', 'en', false, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_za', 'Amazon Güney Afrika', 'ZA', 'ZAR', 'en', false, 'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-eu.amazon.com'),
  ('amazon_mx', 'Amazon Meksika', 'MX', 'MXN', 'es', false, 'https://sandbox.sellingpartnerapi-na.amazon.com', 'https://sellingpartnerapi-na.amazon.com'),
  ('amazon_br', 'Amazon Brezilya', 'BR', 'BRL', 'pt', false, 'https://sandbox.sellingpartnerapi-na.amazon.com', 'https://sellingpartnerapi-na.amazon.com'),
  ('amazon_jp', 'Amazon Japonya', 'JP', 'JPY', 'ja', false, 'https://sandbox.sellingpartnerapi-fe.amazon.com', 'https://sellingpartnerapi-fe.amazon.com'),
  ('amazon_au', 'Amazon Avustralya', 'AU', 'AUD', 'en', false, 'https://sandbox.sellingpartnerapi-fe.amazon.com', 'https://sellingpartnerapi-fe.amazon.com'),
  ('amazon_sg', 'Amazon Singapur', 'SG', 'SGD', 'en', false, 'https://sandbox.sellingpartnerapi-fe.amazon.com', 'https://sellingpartnerapi-fe.amazon.com')
) as v(code, name, cc, cur, lang, gpsr, sandbox, live)
cross join (select * from public.marketplaces where code = 'amazon_de') d
on conflict (code) do nothing;

-- Mevcut Amazon pazarlarının API adresleri
update public.marketplaces set api_sandbox_url = 'https://sandbox.sellingpartnerapi-eu.amazon.com', api_live_url = 'https://sellingpartnerapi-eu.amazon.com'
where code in ('amazon_tr', 'amazon_uk', 'amazon_de', 'amazon_it', 'amazon_fr', 'amazon_nl', 'amazon_pl') and api_live_url is null;
update public.marketplaces set api_sandbox_url = 'https://sandbox.sellingpartnerapi-na.amazon.com', api_live_url = 'https://sellingpartnerapi-na.amazon.com'
where code in ('amazon_us', 'amazon_ca') and api_live_url is null;

-- Amazon siparişi tedarikçiye (yalnız AliExpress / CJ kaynaklı ürünler; ürün kaynağı kuralı) -> orders
-- (marketplace_orders satırı amazon-orders işçisi tarafından yazılır)
create or replace function public.marketplace_order_to_supplier_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_supplier text;
begin
  if new.marketplace_code not like 'amazon\_%' or new.product_id is null or new.status <> 'new' then return new; end if;
  select supplier into v_supplier from public.products where id = new.product_id;
  if v_supplier is null or v_supplier not in ('aliexpress', 'cj') then return new; end if;
  if exists (select 1 from public.orders o where o.user_id = new.user_id and o.marketplace_order_no = new.external_order_id and o.product_id = new.product_id) then return new; end if;
  insert into public.orders (user_id, product_id, platform, marketplace_order_no, customer_name, customer_phone, customer_address, customer_city,
    customer_district, customer_zip, customer_country, quantity, unit_price, currency, supplier, status, hold_reason, note, variant_id)
  values (new.user_id, new.product_id, new.marketplace_code, new.external_order_id, new.buyer_name, new.buyer_phone,
    concat_ws(' ', new.buyer_address->>'line1', new.buyer_address->>'line2', new.buyer_address->>'line3'), new.buyer_address->>'city',
    new.buyer_address->>'district', new.buyer_address->>'zip', coalesce(new.buyer_country::text, new.buyer_address->>'country', 'TR'),
    greatest(1, least(99, new.quantity)), new.item_price, new.currency, v_supplier,
    case when coalesce(new.buyer_address->>'line1', '') = '' then 'onay_bekliyor' else 'beklemede' end,
    case when coalesce(new.buyer_address->>'line1', '') = '' then 'adres_yok' end,
    case when coalesce(new.buyer_address->>'line1', '') = '' then '🟡 Amazon alıcı adresi gelmedi (uygulamada kişisel veri izni gerekli)' else '🟡 Amazon siparişinden otomatik hazırlandı' end,
    new.variant_id);
  return new;
exception when others then
  raise warning 'marketplace_order_to_supplier_order: %', sqlerrm;
  return new;
end $$;
drop trigger if exists trg_marketplace_order_to_supplier on public.marketplace_orders;
create trigger trg_marketplace_order_to_supplier after insert on public.marketplace_orders
for each row execute function public.marketplace_order_to_supplier_order();

-- Asistan: pazaryeri siparişi bildirimi (Kendi Mağazam siparişleri store_orders tetikleyicisinden gelir)
create or replace function public.assistant_on_marketplace_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.marketplace_code = 'own_store' then return new; end if;
  perform public.assistant_enqueue(new.user_id, 'new_order',
    jsonb_build_object('product_id', new.product_id, 'quantity', new.quantity, 'unit_price', new.item_price, 'currency', new.currency,
                       'customer', new.buyer_name, 'city', new.buyer_address->>'city', 'marketplace', new.marketplace_code),
    'mporder:' || new.id::text);
  return new;
exception when others then
  return new;
end $$;
drop trigger if exists trg_assistant_marketplace_order on public.marketplace_orders;
create trigger trg_assistant_marketplace_order after insert on public.marketplace_orders
for each row execute function public.assistant_on_marketplace_order();
