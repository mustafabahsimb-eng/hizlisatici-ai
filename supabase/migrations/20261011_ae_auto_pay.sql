-- Seltigo - AliExpress siparişlerinde otomatik ödeme ayarı (varsayılan AÇIK, CJ ile tutarlı)
-- Zarar kontrolü bu ayardan bağımsız her zaman çalışır.
alter table public.user_profiles
  add column if not exists ae_auto_pay boolean not null default true;
