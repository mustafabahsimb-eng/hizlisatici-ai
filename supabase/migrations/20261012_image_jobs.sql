-- Görsel tamamlama arka planda (satıcı beklemez; bitince panelde bildirim).
-- Toplu Ürün Yükleme görseli / özelliği eksik ürünler için iş açar; image-complete-worker (2 dk) işler.

create table if not exists public.image_job_batches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  total       int not null default 0,
  found       int not null default 0,
  missing     int not null default 0,
  status      text not null default 'running' check (status in ('running', 'done')),
  notified_at timestamptz,             -- satıcı panelde bildirimi kapattı
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.image_jobs (
  id              bigint generated always as identity primary key,
  batch_id        uuid not null references public.image_job_batches(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  product_id      bigint not null references public.products(id) on delete cascade,
  wholesaler_site text,                -- dosyada yazan toptancı sitesi (zincirin 2. adımı)
  status          text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  result_kind     text,                -- brand_media_kit | brand_site | wholesaler | cj | aliexpress | missing
  attempts        int not null default 0,
  error           text,
  next_attempt_at timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists image_jobs_queue_idx on public.image_jobs (next_attempt_at) where status in ('pending', 'running');
create index if not exists image_jobs_batch_idx on public.image_jobs (batch_id);

-- Marka -> resmi site önbelleği (tüm satıcılar için ortak; her seferinde yapay zekâya sorulmasın)
create table if not exists public.brand_sites (
  brand_key  text primary key,
  site       text,                     -- boş: bulunamadı
  checked_at timestamptz not null default now()
);

alter table public.image_job_batches enable row level security;
alter table public.image_jobs enable row level security;
alter table public.brand_sites enable row level security;  -- yalnız sunucu

drop policy if exists own_batches_select on public.image_job_batches;
create policy own_batches_select on public.image_job_batches for select to authenticated using (user_id = auth.uid());
drop policy if exists own_batches_insert on public.image_job_batches;
create policy own_batches_insert on public.image_job_batches for insert to authenticated with check (user_id = auth.uid());
drop policy if exists own_batches_update on public.image_job_batches;
create policy own_batches_update on public.image_job_batches for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_jobs_select on public.image_jobs;
create policy own_jobs_select on public.image_jobs for select to authenticated using (user_id = auth.uid());
drop policy if exists own_jobs_insert on public.image_jobs;
create policy own_jobs_insert on public.image_jobs for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.products p where p.id = product_id and p.user_id = auth.uid()));
