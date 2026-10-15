-- =========================================================
-- Baskılı ürün sorun bildirimi -> Printify ücretsiz yeniden gönderim (pod-reprint)
-- Alıcı order-help.html'den Etsy sipariş no + e-posta / posta kodu + fotoğraf gönderir; sipariş başına bir kayıt.
-- Paket anahtarı: pod_reprint (varsayılan açık)
-- =========================================================
create table if not exists public.pod_reprints (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  etsy_shop_id text not null,
  etsy_receipt_id text not null unique,
  reason text not null,
  description text,
  photo_urls text[] not null default '{}',
  personalized boolean not null default false,
  status text not null default 'received',          -- received | requested | error
  attempts int not null default 0,
  printify_order_id text, printify_request_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.pod_reprints enable row level security;
drop policy if exists pod_reprints_own on public.pod_reprints;
create policy pod_reprints_own on public.pod_reprints for select to authenticated using (user_id = auth.uid());

insert into public.feature_flags (key, name_tr, note) values
  ('pod_reprint', 'Baskılı ürün sorun bildirimi -> otomatik yeniden gönderim', 'Printify reprint talebi')
on conflict (key) do nothing;
