-- =========================================================
-- Seltigo Ads (A1 Meta katalog reklamı + A2 kural motoru)
-- Satıcı bütçe sınırını ve hedefi bir kez girer; sistem kârlı ürünlere reklam açar, ölçer, büyütür / durdurur.
-- Para harcayan her iş: üst sınır (günlük + aylık) kontrolü; zarar kontrolü kapatılamaz.
-- Varsayılan: otomatik açma KAPALI, yeni reklam DURAKLATILMIŞ açılır (satıcı ilk seferde onaylar). ADS_LIVE secret yoksa yalnız sandbox reklam hesabı.
-- Paket anahtarı: ads_auto (feature_flags)
-- =========================================================
create table if not exists public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'meta' check (platform in ('meta', 'google', 'tiktok')),
  external_id text not null,                       -- Meta: act_<id>
  name text,
  currency text,
  timezone text,
  sandbox boolean not null default false,
  page_id text,                                    -- reklamı yayınlayan Facebook Sayfası
  instagram_id text,
  pixel_id text,
  catalog_id text,
  status text not null default 'connected' check (status in ('connected', 'error', 'disabled')),
  last_error text,
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, external_id)
);
alter table public.ad_accounts enable row level security;
drop policy if exists own_ad_accounts on public.ad_accounts;
create policy own_ad_accounts on public.ad_accounts for select to authenticated using (user_id = auth.uid());

create table if not exists public.ad_rules (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auto_launch boolean not null default false,       -- kârlı ürünlere kendiliğinden reklam aç
  daily_cap numeric not null default 0,             -- günlük üst sınır (hesap para birimi); 0 = reklam açılmaz
  monthly_cap numeric not null default 0,           -- aylık üst sınır; aşılırsa tüm reklamlar durur
  target_roas numeric not null default 3,           -- hedef ROAS (satış / harcama)
  min_margin_pct numeric not null default 25,       -- reklam açılacak ürünün en düşük kâr oranı (reklam öncesi)
  auto_scale boolean not null default false,        -- hedefin üstündeki reklamın bütçesini artır
  scale_pct numeric not null default 20,
  pause_after_days int not null default 3,          -- bu kadar gün hedefin altında kalırsa durdur
  min_spend_to_judge numeric not null default 0,    -- karar için en az harcama (0 = günlük bütçenin 1 katı)
  countries text[] not null default '{TR}',
  approval_mode text not null default 'approve' check (approval_mode in ('approve', 'direct')),   -- yeni reklam: onaya / doğrudan yayına
  updated_at timestamptz not null default now()
);
alter table public.ad_rules enable row level security;
drop policy if exists own_ad_rules on public.ad_rules;
create policy own_ad_rules on public.ad_rules for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.ad_accounts(id) on delete cascade,
  platform text not null default 'meta',
  kind text not null default 'catalog' check (kind in ('catalog', 'single')),
  name text not null,
  product_ids bigint[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'active', 'paused', 'stopped', 'error')),
  daily_budget numeric not null,
  currency text,
  external_campaign_id text, external_adset_id text, external_ad_id text, external_creative_id text, external_product_set_id text,
  created_by text not null default 'auto' check (created_by in ('auto', 'seller', 'assistant')),
  paused_reason text,
  last_error text,
  roas_7d numeric, spend_7d numeric, revenue_7d numeric,
  below_target_since date,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ad_campaigns_user_idx on public.ad_campaigns (user_id, status);
alter table public.ad_campaigns enable row level security;
drop policy if exists own_ad_campaigns on public.ad_campaigns;
create policy own_ad_campaigns on public.ad_campaigns for select to authenticated using (user_id = auth.uid());

create table if not exists public.ad_creatives (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id uuid references public.ad_campaigns(id) on delete cascade,
  product_id bigint references public.products(id) on delete cascade,
  variant int not null default 1,
  primary_text text not null,
  headline text,
  description text,
  image_url text,
  external_id text,
  created_at timestamptz not null default now()
);
alter table public.ad_creatives enable row level security;
drop policy if exists own_ad_creatives on public.ad_creatives;
create policy own_ad_creatives on public.ad_creatives for select to authenticated using (user_id = auth.uid());

-- Ürün × kampanya × gün ölçümü (Meta: product_id kırılımı)
create table if not exists public.ad_metrics_daily (
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  product_id bigint not null default 0,            -- 0 = kampanya toplamı
  day date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  spend numeric not null default 0, impressions bigint not null default 0, clicks bigint not null default 0,
  purchases numeric not null default 0, revenue numeric not null default 0,
  currency text,
  updated_at timestamptz not null default now(),
  primary key (campaign_id, product_id, day)
);
alter table public.ad_metrics_daily enable row level security;
drop policy if exists own_ad_metrics on public.ad_metrics_daily;
create policy own_ad_metrics on public.ad_metrics_daily for select to authenticated using (user_id = auth.uid());

-- Harcama defteri (üst sınır kontrolü; günlük kampanya harcaması)
create table if not exists public.ad_spend_ledger (
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  day date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null default 0,
  currency text,
  primary key (campaign_id, day)
);
alter table public.ad_spend_ledger enable row level security;
drop policy if exists own_ad_spend on public.ad_spend_ledger;
create policy own_ad_spend on public.ad_spend_ledger for select to authenticated using (user_id = auth.uid());

-- Sipariş hangi reklamdan geldi (UTM / fbclid; vitrin -> create-store-order)
alter table public.store_orders add column if not exists ad_source jsonb;

-- Paket anahtarı
insert into public.feature_flags (key, name_tr, enabled, note) values ('ads_auto', 'Seltigo Ads (reklam otomasyonu)', true, 'Meta katalog reklamı, kural motoru')
on conflict (key) do nothing;

-- Optimizasyon günü ve kampanyanın başabaş ROAS'ı (ürünlerin ağırlıklı ortalaması)
alter table public.ad_campaigns add column if not exists optimized_on date;
alter table public.ad_campaigns add column if not exists breakeven_roas numeric;
