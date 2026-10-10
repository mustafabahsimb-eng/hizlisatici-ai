-- Seltigo - CJ giriş anahtarı önbelleği (anahtar 180 gün geçerli; getAccessToken saniyede 1 çağrı)
-- Sadece sunucu (service_role) okur/yazar: RLS açık, politika yok.
create table if not exists public.cj_tokens (
  key_hash text primary key,
  access_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.cj_tokens enable row level security;
revoke all on public.cj_tokens from anon, authenticated;
