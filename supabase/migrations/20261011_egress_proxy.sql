-- Sabit IP çıkışı (egress proxy) ayarı — tek satır, varsayılan KAPALI.
-- Kod: supabase/functions/_shared/egress.ts, sağlık kontrolü: egress-health.
-- Kurulum: docs/sabit-ip-kurulumu.md. Şifre burada değil, Edge Function secret EGRESS_PROXY_PASSWORD'da.

create table if not exists public.egress_proxy (
  id            int primary key default 1 check (id = 1),
  enabled       boolean not null default false,       -- ana anahtar
  host          text,                                 -- sunucunun IPv4 adresi (sabit IP)
  port          int not null default 3128,
  username      text not null default 'seltigo',
  hosts         text[] not null default array[        -- yalnız bu alan adlarına giden istekler proxy'den çıkar
                  'developers.cjdropshipping.com',
                  'apigw.trendyol.com',
                  'stageapigw.trendyol.com',
                  'marketplace-api.emag.ro',
                  'marketplace-api.emag.bg',
                  'marketplace-api.emag.hu'
                ],
  status        text not null default 'unknown' check (status in ('unknown', 'ok', 'down')),
  fail_count    int not null default 0,               -- art arda başarısız sağlık kontrolü
  last_ok_at    timestamptz,
  last_check_at timestamptz,
  last_ip       text,                                 -- proxy üzerinden görülen çıkış IP'si
  last_error    text,
  last_error_at timestamptz,
  updated_at    timestamptz not null default now()
);

insert into public.egress_proxy (id) values (1) on conflict (id) do nothing;

-- Yalnız sunucu tarafı (service role) okur/yazar; tarayıcıdan erişim yok.
alter table public.egress_proxy enable row level security;
revoke all on public.egress_proxy from anon, authenticated;
