-- =========================================================
-- Seltigo - OAuth anahtar sağlığı (otomatik yenileme + panel uyarısı)
-- token-refresher (zamanlanmış) anahtarları süresi dolmadan yeniler; yenileyemezse
-- durum alanlarına yazar, panel bu alanlardan Türkçe uyarı gösterir.
-- =========================================================

-- Sitenin kendi hesapları (ör. AliExpress ürün arama)
alter table public.platform_tokens
  add column if not exists status text not null default 'ok',
  add column if not exists last_error text,
  add column if not exists refreshed_at timestamptz;

-- Sosyal hesaplar (Instagram, Facebook, WhatsApp)
alter table public.social_channels
  add column if not exists token_status text not null default 'ok',
  add column if not exists token_error text;

-- Site sahibine sitenin hesaplarının durumu (anahtarlar değil, sadece durum)
create or replace function public.platform_token_health()
returns table (platform text, status text, last_error text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.platform, p.status, p.last_error, p.expires_at
  from public.platform_tokens p
  where public.hs_is_owner();
$$;

revoke all on function public.platform_token_health() from public, anon;
grant execute on function public.platform_token_health() to authenticated;
