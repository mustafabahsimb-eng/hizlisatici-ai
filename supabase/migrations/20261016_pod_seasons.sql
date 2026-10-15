-- =========================================================
-- 1) Baskılı ürün (POD) kişiselleştirme otomasyonu (Printify + Etsy)
--    pod_products: Printify ürünü <-> Etsy ilanı <-> tasarım; kişiselleştirilmiş ürünün baskı yerleşimi
--    pod_personal_orders: kişiselleştirilmiş her sipariş (Printify'ın açtığı bekleyen sipariş -> isimli yeni sipariş)
-- 2) Sezon takvimi: her sezonun yayına çıkış / pasife alma kuralları; ilanlar SİLİNMEZ, pasife alınır, ertesi yıl
--    yorum ve satış geçmişiyle yeniden açılır. Sezondan 2 hafta önce Etsy aramaları kontrol edilir.
-- Paket anahtarları: pod_personalize, season_calendar (varsayılan açık)
-- =========================================================

create table if not exists public.pod_products (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'printify',
  provider_shop_id text not null,
  provider_product_id text not null,
  blueprint_id int, print_provider_id int,
  design_key text not null,
  season_key text,                                   -- seasons.key (evergreen sezonlar dahil)
  marketplace_code text not null default 'etsy',
  external_listing_id text,                          -- Etsy ilan no (yayından sonra)
  personalized boolean not null default false,
  personalization jsonb,                             -- {base_images:{dark,light}: url, names:{center_y, max_w, font_px, ink:{dark,light}}, dark_colors:[...]}
  status text not null default 'draft',              -- draft | published | inactive
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_product_id)
);
alter table public.pod_products enable row level security;
drop policy if exists pod_products_own on public.pod_products;
create policy pod_products_own on public.pod_products for select to authenticated using (user_id = auth.uid());

create table if not exists public.pod_personal_orders (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_shop_id text not null,
  source_order_id text not null unique,              -- Printify'ın Etsy'den aldığı (bekleyen) sipariş
  etsy_receipt_id text,
  personalization text,                              -- alıcının yazdığı metin (ham)
  names text[],
  print_files jsonb,                                 -- üretilen isim katmanları (adres)
  new_order_id text,                                 -- isimli yeni Printify siparişi
  status text not null default 'pending',            -- pending | created | in_production | shipped | error | skipped
  tracking jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.pod_personal_orders enable row level security;
drop policy if exists pod_orders_own on public.pod_personal_orders;
create policy pod_orders_own on public.pod_personal_orders for select to authenticated using (user_id = auth.uid());

-- ---------------- Sezon takvimi ----------------
-- Tarih kuralı: 'fixed:MM-DD' | 'easter' | 'nth:AY:HAFTAGÜNÜ:N' (HAFTAGÜNÜ 0=Pazar; ör. Anneler Günü nth:5:0:2)
-- Yayına çıkış = bayram + launch_offset gün; pasife alma = end_rule varsa o gün, yoksa bayram + end_offset gün
create table if not exists public.seasons (
  key text primary key,
  name_tr text not null,
  name_en text not null,
  holiday_rule text,                                 -- null = her yıl açık (evergreen)
  launch_offset int,
  end_offset int,
  end_rule text,
  themes text[] not null default '{}',               -- tasarım temaları
  trend_seeds text[] not null default '{}',          -- Etsy'de yükselen arama kontrolü için tohum kelimeler
  trend_tags text[] not null default '{}',           -- kontrol sonrası eklenen temalar (her yıl güncellenir)
  evergreen boolean not null default false,
  sort int not null default 100
);
alter table public.seasons enable row level security;
drop policy if exists seasons_read on public.seasons;
create policy seasons_read on public.seasons for select to anon, authenticated using (true);

insert into public.seasons (key, name_tr, name_en, holiday_rule, launch_offset, end_offset, end_rule, themes, trend_seeds, evergreen, sort) values
 ('christmas', 'Noel', 'Christmas', 'fixed:12-25', -71, 1, null,
   '{most likely to,retro christmas,gingerbread,pink christmas,family christmas}', '{christmas sweatshirt,family christmas shirts,most likely to christmas,retro christmas sweatshirt,pink christmas}', false, 10),
 ('thanksgiving', 'Şükran Günü', 'Thanksgiving', 'nth:11:4:4', -42, 1, null,
   '{thankful,fall family,turkey day}', '{thanksgiving shirt,thankful sweatshirt,friendsgiving shirt}', false, 11),
 ('new_year', 'Yılbaşı', 'New Year', 'fixed:01-01', -47, 1, null,
   '{new year party,cheers,hello new year}', '{new years eve shirt,new year sweatshirt,nye outfit}', false, 12),
 ('valentines', 'Sevgililer Günü', 'Valentine''s Day', 'fixed:02-14', -56, 1, null,
   '{retro hearts,galentines,teacher valentine}', '{valentines sweatshirt,galentines shirt,valentine teacher shirt}', false, 20),
 ('st_patricks', 'Aziz Patrick Günü', 'St. Patrick''s Day', 'fixed:03-17', -51, 1, null,
   '{lucky,shamrock,retro clover}', '{st patricks shirt,lucky sweatshirt,shamrock shirt}', false, 30),
 ('easter', 'Paskalya', 'Easter', 'easter', -55, 1, null,
   '{easter bunny,spring pastel,he is risen}', '{easter shirt,easter sweatshirt,bunny shirt}', false, 40),
 ('mothers_day', 'Anneler Günü', 'Mother''s Day', 'nth:5:0:2', -55, 1, null,
   '{mama,custom mom,grandma}', '{mama sweatshirt,custom mom shirt,mothers day gift}', false, 50),
 ('grad_fathers', 'Mezuniyet + Babalar Günü', 'Graduation & Father''s Day', 'nth:6:0:3', -80, 1, null,
   '{dad jokes,class of,grad family}', '{fathers day shirt,dad shirt,graduation shirt}', false, 60),
 ('july4_summer', '4 Temmuz + yaz (tişört)', '4th of July & Summer', 'fixed:07-04', -50, null, 'fixed:08-31',
   '{retro usa,summer vibes,beach}', '{4th of july shirt,america shirt,summer tshirt}', false, 70),
 ('back_to_school_fall', 'Okula dönüş + sonbahar', 'Back to School & Fall', 'fixed:07-01', 0, null, 'fixed:11-30',
   '{teacher,fall vibes,pumpkin spice,cozy season}', '{teacher shirt,fall sweatshirt,back to school shirt}', false, 80),
 ('halloween', 'Cadılar Bayramı', 'Halloween', 'fixed:10-31', -77, 1, null,
   '{retro ghost,spooky season,witchy}', '{halloween sweatshirt,spooky season shirt,ghost sweatshirt}', false, 90),
 ('ev_bookish', 'Kitapsever (her yıl açık)', 'Book lovers', null, null, null, null, '{bookish,reading}', '{bookish sweatshirt,book lover gift}', true, 200),
 ('ev_stoic', 'Stoacı kısa sözler (her yıl açık)', 'Stoic quotes', null, null, null, null, '{stoic quotes,minimalist}', '{stoic quote print,stoicism wall art}', true, 201),
 ('ev_beanie_animals', 'Bereli retro hayvanlar (her yıl açık)', 'Retro beanie animals', null, null, null, null, '{frog,cat,bird}', '{frog sweatshirt,cat sweatshirt,cute animal sweatshirt}', true, 202),
 ('ev_mama', 'İsimli Mama / Grandma (her yıl açık)', 'Personalized Mama & Grandma', null, null, null, null, '{mama,grandma,kids names}', '{mama sweatshirt,custom grandma shirt}', true, 203)
on conflict (key) do update set name_tr = excluded.name_tr, name_en = excluded.name_en, holiday_rule = excluded.holiday_rule, launch_offset = excluded.launch_offset,
  end_offset = excluded.end_offset, end_rule = excluded.end_rule, evergreen = excluded.evergreen, sort = excluded.sort;

-- Satıcının ilanı hangi sezona ait (Seltigo dışında açılmış ilanlar da eklenebilir)
create table if not exists public.season_listings (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  season_key text not null references public.seasons(key),
  marketplace_code text not null default 'etsy',
  external_listing_id text not null,
  title text,
  state text,                                        -- son bilinen durum: active | inactive
  last_action text, last_action_at timestamptz, last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, marketplace_code, external_listing_id)
);
alter table public.season_listings enable row level security;
drop policy if exists season_listings_own on public.season_listings;
create policy season_listings_own on public.season_listings for select to authenticated using (user_id = auth.uid());

-- Yükselen arama kontrolü (Etsy resmi API: findAllListingsActive) — sezon başına yıllık kayıt
create table if not exists public.season_trend_checks (
  id bigserial primary key,
  season_key text not null references public.seasons(key),
  cycle_year int not null,                           -- bayramın yılı
  checked_at timestamptz not null default now(),
  results jsonb not null,                            -- [{keyword, count, prev_count, growth, top_tags:[...]}]
  added_tags text[] not null default '{}',
  unique (season_key, cycle_year)
);
alter table public.season_trend_checks enable row level security;

insert into public.feature_flags (key, name_tr, note) values
  ('pod_personalize', 'Kişiselleştirilmiş baskılı ürün siparişi (isimli baskı otomatik)', 'Printify + Etsy'),
  ('season_calendar', 'Sezon takvimi (ilanları sezona göre yayına al / pasife al)', null)
on conflict (key) do nothing;
