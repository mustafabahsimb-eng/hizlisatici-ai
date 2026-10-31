-- =========================================================
-- PDF + link ile ürün yükleme (WhatsApp / Telegram asistanı ve panel aynı motoru kullanır: catalog-import)
--   catalog_imports      : yükleme geçmişi (kaynak, durum, sayılar)
--   catalog_import_rows  : okunan satırlar (PDF / link / birleşik), eksikler ve hatalar
--   sync_jobs            : 'catalog_import' iş türü (parça parça işlenir; sync-worker catalog-import'a devreder)
--   catalog-uploads      : özel depo, yalnız PDF, en fazla 20 MB
--   rate_hit()           : numara / kullanıcı başına istek sınırı
--   ai_usage_log + ai_quota_ok() : yapay zekâ kullanımı sayılır, pakete kota bağlanabilir (varsayılan sınırsız)
--   feature_flags 'pdf_link_import'
-- =========================================================

create table if not exists public.catalog_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'panel' check (source in ('panel','whatsapp','telegram','instagram','messenger','test')),
  link_id uuid references public.assistant_links(id) on delete set null,
  status text not null default 'parsing' check (status in ('parsing','merging','need_margin','saving','ready','publishing','published','failed','cancelled')),
  pdf_path text,
  pdf_name text,
  pdf_pages integer,
  pdf_kind text,                       -- images | text | scan
  pdf_status text not null default 'none' check (pdf_status in ('none','running','done','failed')),
  pdf_chunks integer not null default 0,
  pdf_chunks_done integer not null default 0,
  link_url text,
  link_platform text,                  -- shopify | woocommerce | ikas | ticimax | sitemap | web ...
  link_status text not null default 'none' check (link_status in ('none','discover','links','pages','done','failed')),
  pending_links jsonb,
  link_chunks integer not null default 0,
  link_chunks_done integer not null default 0,
  save_chunks integer not null default 0,
  save_chunks_done integer not null default 0,
  publish_chunks integer not null default 0,
  publish_chunks_done integer not null default 0,
  price_type text,                     -- wholesale | retail | unknown
  margin numeric,
  found integer not null default 0,
  missing integer not null default 0,
  created integer not null default 0,
  updated integer not null default 0,
  failed integer not null default 0,
  ai_calls integer not null default 0,
  method text,                         -- free | ai | mixed
  error text,
  distributed jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  notified_at timestamptz,
  published_at timestamptz
);
create index if not exists catalog_imports_user_idx on public.catalog_imports (user_id, created_at desc);
alter table public.catalog_imports enable row level security;
drop policy if exists catalog_imports_own on public.catalog_imports;
create policy catalog_imports_own on public.catalog_imports for select using (auth.uid() = user_id);

create table if not exists public.catalog_import_rows (
  id bigserial primary key,
  import_id uuid not null references public.catalog_imports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('pdf','link')),
  final boolean not null default false,      -- birleştirmeden sonra kaydedilecek satır
  merged_from bigint,                        -- PDF satırına bilgi veren link satırı
  page integer,
  idx integer,
  name text,
  brand text,
  model_code text,
  sku text,
  barcode text,
  cost numeric,
  list_price numeric,
  sale_price numeric,
  currency text,
  stock integer,
  variants jsonb,
  description text,
  specs jsonb,
  images jsonb,
  url text,
  item jsonb,                                -- linkten gelen tam ürün
  status text not null default 'new' check (status in ('new','ok','missing','created','updated','error','skipped','unmatched')),
  problems text[],
  error text,
  product_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists catalog_import_rows_import_idx on public.catalog_import_rows (import_id, source, idx);
alter table public.catalog_import_rows enable row level security;
drop policy if exists catalog_import_rows_own on public.catalog_import_rows;
create policy catalog_import_rows_own on public.catalog_import_rows for select using (auth.uid() = user_id);

-- Sayaçlar (paralel parçalar yarışmasın): alan adına 1 ekler, güncel satırı döndürür
create or replace function public.catalog_import_bump(p_id uuid, p_field text, p_by integer default 1)
returns public.catalog_imports language plpgsql security definer set search_path = public as $$
declare r public.catalog_imports;
begin
  if p_field not in ('pdf_chunks_done','link_chunks_done','save_chunks_done','publish_chunks_done','ai_calls') then
    raise exception 'catalog_import_bump: alan %', p_field;
  end if;
  execute format('update public.catalog_imports set %I = %I + $1, updated_at = now() where id = $2 returning *', p_field, p_field)
    into r using p_by, p_id;
  return r;
end $$;
revoke all on function public.catalog_import_bump(uuid, text, integer) from public, anon, authenticated;

-- Durum geçişi yalnız bir kez (ör. parsing -> merging): başarılıysa true
create or replace function public.catalog_import_step(p_id uuid, p_from text[], p_to text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  update public.catalog_imports set status = p_to, updated_at = now() where id = p_id and status = any(p_from) returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
revoke all on function public.catalog_import_step(uuid, text[], text) from public, anon, authenticated;

-- sync_jobs: yeni iş türü
alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check check (job_type = any (array[
  'trendyol_batch_check','listing_sync','publish_listing','update_price','update_stock','update_content','unpublish_listing',
  'fetch_orders','push_tracking','translate_listing','verify_connection','other','catalog_import']));

-- Özel depo: yalnız PDF, en fazla 20 MB; satıcı yalnız kendi klasörüne yükler / okur
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalog-uploads', 'catalog-uploads', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 20971520, allowed_mime_types = array['application/pdf'];
drop policy if exists catalog_uploads_insert on storage.objects;
create policy catalog_uploads_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'catalog-uploads' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists catalog_uploads_select on storage.objects;
create policy catalog_uploads_select on storage.objects for select to authenticated
  using (bucket_id = 'catalog-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

-- İstek sınırı: anahtar başına pencere içinde en fazla p_limit; aşılırsa false
create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);
alter table public.rate_limits enable row level security;
create or replace function public.rate_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_hits integer;
begin
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;
revoke all on function public.rate_hit(text, integer, integer) from public, anon, authenticated;

-- Yapay zekâ kullanımı: sunucu da yazar (birim + jeton); kota tablosu boşsa sınırsız
alter table public.ai_usage_log add column if not exists units integer not null default 1;
alter table public.ai_usage_log add column if not exists input_tokens integer;
alter table public.ai_usage_log add column if not exists output_tokens integer;
alter table public.ai_usage_log add column if not exists ref text;
create index if not exists ai_usage_log_user_month_idx on public.ai_usage_log (user_id, created_at);
create table if not exists public.ai_quotas (
  scope text primary key,              -- 'default' ya da kullanıcı kimliği
  monthly_units integer,               -- boş = sınırsız
  note text,
  updated_at timestamptz not null default now()
);
alter table public.ai_quotas enable row level security;
create or replace function public.ai_quota_ok(p_user uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_lim integer; v_used integer;
begin
  select monthly_units into v_lim from public.ai_quotas where scope = p_user::text;
  if not found then select monthly_units into v_lim from public.ai_quotas where scope = 'default'; end if;
  if v_lim is null then return true; end if;
  select coalesce(sum(units), 0) into v_used from public.ai_usage_log
   where user_id = p_user and created_at >= date_trunc('month', now());
  return v_used < v_lim;
end $$;
revoke all on function public.ai_quota_ok(uuid) from public, anon;
grant execute on function public.ai_quota_ok(uuid) to authenticated;

-- Paket anahtarı (varsayılan açık)
insert into public.feature_flags (key, name_tr, enabled, note)
values ('pdf_link_import', 'PDF + link ile ürün yükleme (WhatsApp / panel)', true, 'catalog-import; WhatsApp / Telegram asistanı ve Toplu Yükleme')
on conflict (key) do nothing;

-- 31 Ekim: PDF satırının siteyle neye göre eşleştiği (barcode | sku | name); panelde gösterilir
alter table public.catalog_import_rows add column if not exists match_by text;
