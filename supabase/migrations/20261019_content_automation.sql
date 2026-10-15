-- =========================================================
-- İçerik otomasyonu (İ1-İ2): haftalık plan -> görsel şablon + metin -> (onay) -> zamanında paylaşım (Instagram / Facebook) -> ölçüm -> öğrenme
-- Varsayılan KAPALI (satıcı tek anahtarla açar); yeni içerik varsayılan onaya düşer. Paket anahtarı: content_auto
-- =========================================================
create table if not exists public.content_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  posts_per_day int not null default 1 check (posts_per_day between 0 and 5),
  stories_per_week int not null default 3 check (stories_per_week between 0 and 21),
  channels text[] not null default '{instagram,facebook}',
  post_hours text[] not null default '{19:30}',          -- yerel saat (HH:MM); öğrenme en iyi saati öne alır
  approval_mode text not null default 'approve' check (approval_mode in ('approve', 'direct')),
  timezone text not null default 'Europe/Istanbul',
  updated_at timestamptz not null default now()
);
alter table public.content_settings enable row level security;
drop policy if exists own_content_settings on public.content_settings;
create policy own_content_settings on public.content_settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('instagram', 'facebook')),
  kind text not null default 'post' check (kind in ('post', 'story', 'carousel')),
  template text not null check (template in ('photo', 'price', 'collage', 'season', 'story')),
  product_ids bigint[] not null default '{}',
  reason text,                                           -- neden seçildi (yeni ürün / çok satan / özel gün …)
  caption text,
  media_urls text[] not null default '{}',
  scheduled_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'error', 'skipped')),
  social_post_id uuid,                                   -- social_posts kaydı
  external_id text,                                      -- Instagram medya / Facebook gönderi no
  external_url text,
  error text,
  metrics jsonb,                                         -- { reach, likes, comments, saves, shares, engagement, checked_at }
  week_start date,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_items_user_idx on public.content_items (user_id, scheduled_at);
create index if not exists content_items_due_idx on public.content_items (status, scheduled_at);
alter table public.content_items enable row level security;
drop policy if exists own_content_items_sel on public.content_items;
create policy own_content_items_sel on public.content_items for select to authenticated using (user_id = auth.uid());

-- Paylaşılan görseller (herkese açık okunur; Instagram görseli adresten çeker)
insert into storage.buckets (id, name, public) values ('content-media', 'content-media', true) on conflict (id) do nothing;

insert into public.feature_flags (key, name_tr, enabled, note) values ('content_auto', 'İçerik otomasyonu', true, 'Haftalık içerik planı, şablon görseller, otomatik paylaşım')
on conflict (key) do nothing;
