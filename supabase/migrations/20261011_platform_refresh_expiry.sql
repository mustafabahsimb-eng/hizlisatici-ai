-- Seltigo - sitenin hesap anahtarlarında yenileme anahtarının bitişi (AliExpress test
-- uygulamasında yenileme anahtarı ilk izinden 48 saat sonra sabit biter; uyarı için gerekli)
alter table public.platform_tokens
  add column if not exists refresh_expires_at timestamptz;

create or replace function public.platform_token_health()
returns table (platform text, status text, last_error text, expires_at timestamptz, refresh_expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.platform, p.status, p.last_error, p.expires_at, p.refresh_expires_at
  from public.platform_tokens p
  where public.hs_is_owner();
$$;

revoke all on function public.platform_token_health() from public, anon;
grant execute on function public.platform_token_health() to authenticated;

-- Mevcut sitenin AliExpress kaydı: satıcı bağlantısıyla aynı izinden geldi
update public.platform_tokens p
  set refresh_expires_at = (select max(refresh_expires_at) from public.supplier_connections where supplier = 'aliexpress')
  where p.platform = 'aliexpress' and p.refresh_expires_at is null;
