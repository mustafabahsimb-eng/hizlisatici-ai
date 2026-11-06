-- =========================================================
-- Seltigo: Kendi sitesini bağlama (site_connect) + tam mağaza (sepet, kupon, kargo, müşteri hesabı, ödeme,
-- kendi alan adı, SEO, taşıma + 301 yönlendirme) + ORTAK STOK (her sipariş stoğu tek merkezden düşer).
-- Yeni tablolar mevcut yapının üzerine kurulur: products / product_variants / listings / store_settings / store_orders /
-- marketplace_orders / sync_jobs değiştirilmez, yalnız sütun eklenir.
-- =========================================================

-- ---------- Gizli değer kasası (Vault) yardımcıları: yalnız service_role ----------
create or replace function public.seltigo_secret_set(p_id uuid, p_name text, p_value jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
begin
  if p_id is null then
    return vault.create_secret(p_value::text, p_name || '_' || gen_random_uuid()::text, 'Seltigo gizli değer');
  end if;
  perform vault.update_secret(p_id, p_value::text);
  return p_id;
end $$;
create or replace function public.seltigo_secret_get(p_id uuid)
returns jsonb language sql security definer set search_path to '' as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where id = p_id;
$$;
revoke all on function public.seltigo_secret_set(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.seltigo_secret_get(uuid) from public, anon, authenticated;
grant execute on function public.seltigo_secret_set(uuid, text, jsonb) to service_role;
grant execute on function public.seltigo_secret_get(uuid) to service_role;

-- ---------- ÖZELLİK 1: Site bağlantıları ----------
create table if not exists public.site_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,                       -- satıcının girdiği adres (normalize)
  origin text not null,                    -- https://www.site.com
  host text not null,                      -- site.com (www'suz)
  scope_path text not null default '/',    -- doğrulama kapsamı (paylaşımlı alan adlarında alt yol)
  purpose text not null default 'connect' check (purpose in ('connect', 'migrate')),
  platform text,                           -- shopify | woocommerce | wix | ikas | ticimax | ideasoft | tsoft | opencart | prestashop | magento | custom
  platform_evidence text,
  method text check (method in ('api', 'feed', 'crawl')),
  feed_url text,                           -- Google Merchant / XML / CSV ürün akışı
  store_connection_id uuid references public.store_connections(id) on delete set null, -- resmi API bağlantısı (Shopify / Woo / Wix)
  verify_token text not null,
  verify_method text check (verify_method in ('meta', 'dns', 'file')),
  verified_at timestamptz,
  verify_checked_at timestamptz,
  verify_error text,
  status text not null default 'pending_verify' check (status in ('pending_verify', 'verified', 'importing', 'active', 'error', 'paused')),
  auto_sync boolean not null default true,
  sync_hours integer not null default 6 check (sync_hours between 1 and 168),
  last_sync_at timestamptz,
  next_sync_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  -- İki yönlü bağlantı ("Seltigo bağlantı kodu")
  api_key_prefix text,
  api_key_hash text,                       -- sha256(hex); anahtarın kendisi saklanmaz, bir kez gösterilir
  api_key_created_at timestamptz,
  api_last_used_at timestamptz,
  webhook_url text,
  webhook_secret_id uuid,                  -- Vault (imza anahtarı)
  webhook_events text[] not null default array['product.created', 'product.updated', 'product.deleted', 'stock.updated', 'order.created'],
  webhook_last_ok_at timestamptz,
  webhook_last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists site_connections_user_site on public.site_connections (user_id, host, scope_path) where deleted_at is null;
create unique index if not exists site_connections_api_key on public.site_connections (api_key_hash) where api_key_hash is not null;
create index if not exists site_connections_next_sync on public.site_connections (next_sync_at) where deleted_at is null and auto_sync and verified_at is not null;
alter table public.site_connections enable row level security;
drop policy if exists site_connections_own on public.site_connections;
create policy site_connections_own on public.site_connections for select to authenticated using (user_id = auth.uid());

create table if not exists public.site_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.site_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'import' check (kind in ('import', 'sync')),
  status text not null default 'queued' check (status in ('queued', 'discover', 'running', 'done', 'error', 'cancelled')),
  source text,                              -- api | feed | crawl
  total integer not null default 0,
  done integer not null default 0,
  created integer not null default 0,
  updated integer not null default 0,
  failed integer not null default 0,
  removed integer not null default 0,
  skipped_robots integer not null default 0,
  chunks integer not null default 0,
  chunks_done integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists site_sync_runs_conn on public.site_sync_runs (connection_id, created_at desc);
alter table public.site_sync_runs enable row level security;
drop policy if exists site_sync_runs_own on public.site_sync_runs;
create policy site_sync_runs_own on public.site_sync_runs for select to authenticated using (user_id = auth.uid());

-- Sitedeki ürün <-> Seltigo ürünü (eşitleme, silinen ürün, 301 haritası)
create table if not exists public.site_product_map (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.site_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id bigint references public.products(id) on delete cascade,
  external_id text,
  url text not null,
  sku text,
  category text,
  hash text,                                -- fiyat + stok + ad özeti (değişmeyen ürün yeniden yazılmaz)
  seen_at timestamptz not null default now(),
  removed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists site_product_map_url on public.site_product_map (connection_id, url);
create index if not exists site_product_map_product on public.site_product_map (product_id);
create index if not exists site_product_map_ext on public.site_product_map (connection_id, external_id) where external_id is not null;
alter table public.site_product_map enable row level security;
drop policy if exists site_product_map_own on public.site_product_map;
create policy site_product_map_own on public.site_product_map for select to authenticated using (user_id = auth.uid());

-- Siteye giden olaylar (webhook kuyruğu; HMAC imzalı, tekrar denemeli)
create table if not exists public.site_webhook_events (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.site_connections(id) on delete cascade,
  user_id uuid not null,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists site_webhook_events_due on public.site_webhook_events (next_at) where status = 'pending';
alter table public.site_webhook_events enable row level security;
drop policy if exists site_webhook_events_own on public.site_webhook_events;
create policy site_webhook_events_own on public.site_webhook_events for select to authenticated using (user_id = auth.uid());

-- Kuyruk: site işi parçaları
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array['trendyol_batch_check', 'listing_sync', 'publish_listing',
  'update_price', 'update_stock', 'update_content', 'unpublish_listing', 'fetch_orders', 'push_tracking', 'translate_listing', 'verify_connection',
  'other', 'catalog_import', 'site_connect']));

-- Ürün olayı -> bağlı sitelerin webhook kuyruğu (yalnız webhook adresi girilmiş bağlantılar; siteden gelen değişiklik geri yollanmaz)
create or replace function public.site_webhook_on_product()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_event text; v_row record;
begin
  if coalesce(current_setting('seltigo.from_site', true), '') = 'on' then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then v_event := 'product.created';
  elsif new.deleted_at is not null and old.deleted_at is null then v_event := 'product.deleted';
  elsif new.stock_qty is distinct from old.stock_qty or new.stock_status is distinct from old.stock_status then v_event := 'stock.updated';
  elsif new.name is distinct from old.name or new.sale_price is distinct from old.sale_price or new.generated_title is distinct from old.generated_title
     or new.image_url is distinct from old.image_url or new.generated_description is distinct from old.generated_description then v_event := 'product.updated';
  else return new; end if;
  for v_row in select id from public.site_connections c
      where c.user_id = new.user_id and c.deleted_at is null and c.webhook_url is not null and v_event = any (c.webhook_events) loop
    insert into public.site_webhook_events (connection_id, user_id, event, payload)
    values (v_row.id, new.user_id, v_event, jsonb_build_object('product_id', new.id, 'sku', new.model_code, 'gtin', new.gtin,
      'stock_qty', new.stock_qty, 'stock_status', new.stock_status, 'price', new.sale_price, 'name', coalesce(new.generated_title, new.name)));
  end loop;
  return new;
end $$;
drop trigger if exists trg_site_webhook_product on public.products;
create trigger trg_site_webhook_product after insert or update on public.products for each row execute function public.site_webhook_on_product();

-- ---------- ORTAK STOK: her yeni sipariş stoğu bir kez düşer, iptal / iadede geri gelir ----------
alter table public.marketplace_orders add column if not exists stock_applied boolean not null default false;
create or replace function public.marketplace_orders_stock()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_q integer; v_def boolean; v_left integer;
begin
  v_q := greatest(coalesce(new.quantity, 1), 1);
  if tg_op = 'INSERT' then
    -- Geçmiş sipariş içe aktarımı (ilk bağlanışta eski siparişler) stoğu düşürmez
    if new.product_id is null or lower(coalesce(new.status, '')) in ('cancelled', 'refunded', 'returned')
       or coalesce(new.ordered_at, now()) < now() - interval '3 days' then return new; end if;
    select is_default into v_def from public.product_variants where id = new.variant_id;
    if new.variant_id is not null and v_def is false then
      update public.product_variants set stock_qty = greatest(stock_qty - v_q, 0),
        stock_status = case when stock_qty - v_q <= 0 then 'tukendi' else stock_status end
      where id = new.variant_id and stock_qty is not null;
    end if;
    update public.products set stock_qty = greatest(stock_qty - v_q, 0),
      stock_status = case when stock_qty - v_q <= 0 then 'tukendi' else stock_status end
    where id = new.product_id and stock_qty is not null returning stock_qty into v_left;
    update public.marketplace_orders set stock_applied = true where id = new.id;
    return new;
  end if;
  -- İptal / iade: düşülen stok geri eklenir (bir kez)
  if new.stock_applied and lower(coalesce(new.status, '')) in ('cancelled', 'refunded', 'returned')
     and lower(coalesce(old.status, '')) not in ('cancelled', 'refunded', 'returned') then
    select is_default into v_def from public.product_variants where id = new.variant_id;
    if new.variant_id is not null and v_def is false then
      update public.product_variants set stock_qty = stock_qty + v_q, stock_status = case when stock_status = 'tukendi' then 'stokta' else stock_status end
      where id = new.variant_id and stock_qty is not null;
    end if;
    update public.products set stock_qty = stock_qty + v_q, stock_status = case when stock_status = 'tukendi' then 'stokta' else stock_status end
    where id = new.product_id and stock_qty is not null;
    update public.marketplace_orders set stock_applied = false where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists trg_marketplace_orders_stock on public.marketplace_orders;
create trigger trg_marketplace_orders_stock after insert or update of status on public.marketplace_orders
  for each row execute function public.marketplace_orders_stock();

-- Seltigo'daki sipariş -> bağlı sitelere order.created (sitenin kendi siparişi geri yollanmaz)
create or replace function public.site_webhook_on_order()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_row record;
begin
  if new.marketplace_code = 'website' then return new; end if;
  for v_row in select id from public.site_connections c
      where c.user_id = new.user_id and c.deleted_at is null and c.webhook_url is not null and 'order.created' = any (c.webhook_events) loop
    insert into public.site_webhook_events (connection_id, user_id, event, payload)
    values (v_row.id, new.user_id, 'order.created', jsonb_build_object('order_id', new.id, 'channel', new.marketplace_code,
      'product_id', new.product_id, 'variant_id', new.variant_id, 'quantity', new.quantity, 'price', new.item_price, 'currency', new.currency));
  end loop;
  return new;
end $$;
drop trigger if exists trg_site_webhook_order on public.marketplace_orders;
create trigger trg_site_webhook_order after insert on public.marketplace_orders for each row execute function public.site_webhook_on_order();

-- ---------- ÖZELLİK 2: Tam mağaza ----------
alter table public.store_settings
  add column if not exists theme jsonb not null default '{}'::jsonb,           -- { preset, colors, font, hero, layout, ai }
  add column if not exists seo jsonb not null default '{}'::jsonb,             -- { title, description, keywords, og_image }
  add column if not exists shipping_options jsonb not null default '[]'::jsonb, -- [{ id, name, price, free_over, days }]
  add column if not exists checkout jsonb not null default '{}'::jsonb,        -- { methods: [cod, bank_transfer, iyzico, paytr], iban, account_name, cod_fee }
  add column if not exists custom_domain text;

alter table public.store_orders
  add column if not exists checkout_id uuid,
  add column if not exists customer_id uuid,
  add column if not exists customer_email text,
  add column if not exists payment_method text,
  add column if not exists payment_status text;

create table if not exists public.store_coupons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  kind text not null default 'percent' check (kind in ('percent', 'amount', 'free_shipping')),
  value numeric not null default 0 check (value >= 0),
  min_total numeric not null default 0,
  max_uses integer,
  used_count integer not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists store_coupons_code on public.store_coupons (user_id, upper(code));
alter table public.store_coupons enable row level security;
drop policy if exists store_coupons_own on public.store_coupons;
create policy store_coupons_own on public.store_coupons for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.store_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,   -- satıcı (müşteri her mağazada ayrı hesap)
  email text not null,
  name text,
  phone text,
  password_hash text not null,
  addresses jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists store_customers_email on public.store_customers (user_id, lower(email));
alter table public.store_customers enable row level security;
drop policy if exists store_customers_seller on public.store_customers;
create policy store_customers_seller on public.store_customers for select to authenticated using (user_id = auth.uid());

create table if not exists public.store_customer_sessions (
  token_hash text primary key,
  customer_id uuid not null references public.store_customers(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.store_customer_sessions enable row level security;

-- Müşteri parolası: bcrypt (pgcrypto); doğrulama yalnız sunucuda
create extension if not exists pgcrypto with schema extensions;
create or replace function public.store_customer_register(p_user uuid, p_email text, p_name text, p_phone text, p_password text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_id uuid;
begin
  insert into public.store_customers (user_id, email, name, phone, password_hash)
  values (p_user, lower(trim(p_email)), p_name, p_phone, extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
  returning id into v_id;
  return v_id;
end $$;
create or replace function public.store_customer_check(p_user uuid, p_email text, p_password text)
returns uuid language sql security definer set search_path to '' as $$
  select id from public.store_customers
  where user_id = p_user and lower(email) = lower(trim(p_email)) and password_hash = extensions.crypt(p_password, password_hash);
$$;
revoke all on function public.store_customer_register(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.store_customer_check(uuid, text, text) from public, anon, authenticated;
grant execute on function public.store_customer_register(uuid, text, text, text, text) to service_role;
grant execute on function public.store_customer_check(uuid, text, text) to service_role;

create table if not exists public.store_checkouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_slug text not null,
  customer_id uuid references public.store_customers(id) on delete set null,
  email text, name text, phone text,
  address jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,       -- [{ product_id, listing_id, variant_id, name, qty, unit_price }]
  subtotal numeric not null default 0,
  discount numeric not null default 0,
  shipping numeric not null default 0,
  cod_fee numeric not null default 0,
  total numeric not null default 0,
  currency text not null default 'TRY',
  coupon_code text,
  shipping_option text,
  payment_method text not null check (payment_method in ('cod', 'bank_transfer', 'iyzico', 'paytr')),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'cod', 'awaiting_transfer', 'cancelled')),
  provider_ref text,
  environment text,                               -- sandbox | live
  order_ids uuid[] not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists store_checkouts_user on public.store_checkouts (user_id, created_at desc);
create index if not exists store_checkouts_customer on public.store_checkouts (customer_id, created_at desc);
alter table public.store_checkouts enable row level security;
drop policy if exists store_checkouts_own on public.store_checkouts;
create policy store_checkouts_own on public.store_checkouts for select to authenticated using (user_id = auth.uid());

create table if not exists public.store_payment_events (
  id bigint generated always as identity primary key,
  checkout_id uuid references public.store_checkouts(id) on delete cascade,
  provider text not null,
  kind text not null,
  ok boolean,
  raw jsonb,
  created_at timestamptz not null default now()
);
alter table public.store_payment_events enable row level security;

-- Satıcının ödeme hesabı (iyzico / PayTR); anahtarlar Vault'ta
create table if not exists public.store_payment_providers (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('iyzico', 'paytr')),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'live')),
  secret_id uuid,
  enabled boolean not null default false,
  verified_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table public.store_payment_providers enable row level security;
drop policy if exists store_payment_providers_own on public.store_payment_providers;
create policy store_payment_providers_own on public.store_payment_providers for select to authenticated using (user_id = auth.uid());

-- Kendi alan adı
create table if not exists public.store_domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_slug text not null,
  hostname text not null,
  status text not null default 'pending_dns' check (status in ('pending_dns', 'verifying', 'active', 'error', 'removed')),
  method text not null default 'manual' check (method in ('manual', 'domain_connect')),
  provider text,                                  -- DNS sağlayıcısı (NS kaydından)
  domain_connect jsonb,                           -- { provider_id, url_sync_ux } destekleniyorsa
  cf_hostname_id text,
  records jsonb not null default '[]'::jsonb,     -- eklenecek DNS kayıtları
  ssl_status text,
  last_check_at timestamptz,
  error text,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists store_domains_host on public.store_domains (lower(hostname)) where status <> 'removed';
alter table public.store_domains enable row level security;
drop policy if exists store_domains_own on public.store_domains;
create policy store_domains_own on public.store_domains for select to authenticated using (user_id = auth.uid());

-- Taşıma: eski adres -> yeni ürün sayfası (301)
create table if not exists public.store_redirects (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  from_path text not null,
  to_url text not null,
  product_id bigint references public.products(id) on delete cascade,
  connection_id uuid references public.site_connections(id) on delete set null,
  hits integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists store_redirects_path on public.store_redirects (user_id, from_path);
alter table public.store_redirects enable row level security;
drop policy if exists store_redirects_own on public.store_redirects;
create policy store_redirects_own on public.store_redirects for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Kupon kullanımı (yarış olmadan, sınırla)
create or replace function public.store_coupon_use(p_id uuid)
returns boolean language plpgsql security definer set search_path to '' as $$
declare v_ok boolean;
begin
  update public.store_coupons set used_count = used_count + 1
  where id = p_id and active and (max_uses is null or used_count < max_uses) returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
revoke all on function public.store_coupon_use(uuid) from public, anon, authenticated;
grant execute on function public.store_coupon_use(uuid) to service_role;

-- ---------- Paket anahtarları (ücretli olabilecek her özellik tek yerden; varsayılan açık) ----------
insert into public.feature_flags (key, name_tr, note) values
  ('site_connect', 'Kendi sitesini bağlama (doğrulama + aktarım + sürekli eşitleme)', 'Shopify / WooCommerce / Wix API, XML akışı, site taraması'),
  ('site_api', 'Seltigo bağlantı kodu (REST API + webhook, iki yönlü)', 'Site yazılımcısı için API anahtarı'),
  ('store_checkout', 'Mağaza sepeti, kupon, kargo seçenekleri, müşteri hesabı', null),
  ('store_payments', 'Mağazada kartla ödeme (iyzico / PayTR)', 'Şirket kurulunca canlı'),
  ('custom_domain', 'Mağazaya kendi alan adı', 'Cloudflare for SaaS (ücretsiz kota)'),
  ('store_migrate', 'Başka altyapıdan mağaza taşıma + 301 yönlendirme', null),
  ('store_ai_design', 'Yapay zekâ ile mağaza tasarımı', null)
on conflict (key) do nothing;

-- Bağlı siteden gelen sipariş kanalı ("Web sitem"); yayın kanalı değildir (is_active=false), yalnız sipariş kaynağı
insert into public.marketplaces (code, name, country_code, currency, language, is_active)
values ('website', 'Web sitem', 'TR', 'TRY', 'tr', false) on conflict (code) do nothing;

-- Siteden gelen stok / ürün değişikliği: aynı olay siteye geri yollanmaz (seltigo.from_site)
create or replace function public.site_product_patch(p_user uuid, p_product bigint, p_patch jsonb)
returns boolean language plpgsql security definer set search_path to '' as $$
declare v_ok boolean;
begin
  perform set_config('seltigo.from_site', 'on', true);
  update public.products set
    name = coalesce(p_patch->>'name', name),
    generated_title = coalesce(p_patch->>'title', generated_title),
    generated_description = coalesce(p_patch->>'description', generated_description),
    sale_price = coalesce((p_patch->>'price')::numeric, sale_price),
    supplier_price = coalesce((p_patch->>'cost')::numeric, supplier_price),
    stock_qty = case when p_patch ? 'stock_qty' then (p_patch->>'stock_qty')::integer else stock_qty end,
    stock_status = case when p_patch ? 'stock_qty' then (case when coalesce((p_patch->>'stock_qty')::integer, 1) <= 0 then 'tukendi' else 'stokta' end) else stock_status end,
    model_code = coalesce(p_patch->>'sku', model_code),
    gtin = coalesce(p_patch->>'gtin', gtin),
    deleted_at = case when (p_patch->>'delete')::boolean then now() else deleted_at end
  where id = p_product and user_id = p_user and deleted_at is null returning true into v_ok;
  -- Kendi Mağazam ilan fiyatı ürünle birlikte
  if v_ok and p_patch ? 'price' then
    update public.listings set price = (p_patch->>'price')::numeric where product_id = p_product and marketplace_code = 'own_store' and deleted_at is null;
  end if;
  return coalesce(v_ok, false);
end $$;
create or replace function public.site_variant_stock(p_user uuid, p_variant uuid, p_qty integer)
returns boolean language plpgsql security definer set search_path to '' as $$
declare v_ok boolean;
begin
  perform set_config('seltigo.from_site', 'on', true);
  update public.product_variants set stock_qty = p_qty, stock_status = case when p_qty <= 0 then 'tukendi' else 'stokta' end
  where id = p_variant and user_id = p_user and deleted_at is null returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
revoke all on function public.site_product_patch(uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.site_variant_stock(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.site_product_patch(uuid, bigint, jsonb) to service_role;
grant execute on function public.site_variant_stock(uuid, uuid, integer) to service_role;
-- Site işi sayaçları (paralel parçalar yarışsız artırır) + bitince tek seferlik kapanış
create or replace function public.site_run_bump(p_id uuid, p_done integer default 0, p_created integer default 0, p_updated integer default 0,
  p_failed integer default 0, p_total integer default 0, p_chunks integer default 0, p_chunks_done integer default 0, p_skipped integer default 0)
returns public.site_sync_runs language sql security definer set search_path to '' as $$
  update public.site_sync_runs set done = done + p_done, created = created + p_created, updated = updated + p_updated,
    failed = failed + p_failed, total = total + p_total, chunks = chunks + p_chunks, chunks_done = chunks_done + p_chunks_done,
    skipped_robots = skipped_robots + p_skipped
  where id = p_id returning *;
$$;
create or replace function public.site_run_finish(p_id uuid)
returns boolean language sql security definer set search_path to '' as $$
  update public.site_sync_runs set status = 'done', finished_at = now()
  where id = p_id and status = 'running' and chunks_done >= chunks returning true;
$$;
revoke all on function public.site_run_bump(uuid, integer, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.site_run_finish(uuid) from public, anon, authenticated;
grant execute on function public.site_run_bump(uuid, integer, integer, integer, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.site_run_finish(uuid) to service_role;
