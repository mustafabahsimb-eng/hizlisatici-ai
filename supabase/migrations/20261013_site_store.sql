-- =========================================================
-- "Link ver, mağazan hazır": site adresinden mağaza kurma, dağıtım, satıcının sitesine yönlendirme
-- =========================================================

-- Ayarlar "Web sitem" + "Satın Al düğmesi kendi siteme gitsin"
alter table public.store_settings add column if not exists website_url text;
alter table public.store_settings add column if not exists buy_on_website boolean not null default false;

-- Siteden ürün çekme işi (arka planda; panel ilerlemeyi okur)
create table if not exists public.site_import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  site_url text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  links jsonb not null default '[]'::jsonb,      -- işlenecek ürün sayfaları
  next_page text,                                -- liste / besleme sonraki sayfa
  total int not null default 0,
  done int not null default 0,
  failed int not null default 0,
  product_ids bigint[] not null default '{}',
  store_slug text,
  error text,
  distributed jsonb,                             -- diğer kanallara gönderim sonucu
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists site_import_jobs_user_idx on public.site_import_jobs (user_id, created_at desc);
alter table public.site_import_jobs enable row level security;
drop policy if exists own_site_jobs_select on public.site_import_jobs;
create policy own_site_jobs_select on public.site_import_jobs for select to authenticated using (user_id = auth.uid());
alter table public.site_import_jobs add column if not exists notified_at timestamptz;   -- panel bildirimi kapatıldı
drop policy if exists own_site_jobs_notify on public.site_import_jobs;
create policy own_site_jobs_notify on public.site_import_jobs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Satıcı yalnız bildirim alanını değiştirebilir (ürün listesi / durum sunucuda)
revoke update on public.site_import_jobs from authenticated, anon;
grant update (notified_at) on public.site_import_jobs to authenticated;

-- Mağazadan satıcının sitesine giden tıklamalar (ürün bazında; satış ilgisi verisi kaybolmasın)
create table if not exists public.store_outbound_clicks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id bigint,
  kind text not null default 'view' check (kind in ('view', 'buy')),   -- "Satıcının sitesinde gör" / Satın Al yönlendirmesi
  created_at timestamptz not null default now()
);
create index if not exists store_outbound_clicks_idx on public.store_outbound_clicks (user_id, product_id, created_at desc);
alter table public.store_outbound_clicks enable row level security;
drop policy if exists own_clicks_select on public.store_outbound_clicks;
create policy own_clicks_select on public.store_outbound_clicks for select to authenticated using (user_id = auth.uid());

-- Vitrin (giriş yapmamış ziyaretçi) tıklamayı kaydeder; yalnız o mağazanın ürünü için, kişisel veri tutulmaz
create or replace function public.log_store_click(p_slug text, p_product_id bigint, p_kind text default 'view')
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  select user_id into v_user from public.store_settings where store_slug = p_slug;
  if v_user is null then return; end if;
  if not exists (select 1 from public.products where id = p_product_id and user_id = v_user) then return; end if;
  -- kötüye kullanım sınırı: aynı ürün için dakikada en fazla 30 kayıt
  if (select count(*) from public.store_outbound_clicks where product_id = p_product_id and created_at > now() - interval '1 minute') >= 30 then return; end if;
  insert into public.store_outbound_clicks (user_id, product_id, kind) values (v_user, p_product_id, case when p_kind = 'buy' then 'buy' else 'view' end);
end $$;
revoke all on function public.log_store_click(text, bigint, text) from public;
grant execute on function public.log_store_click(text, bigint, text) to anon, authenticated;
