-- =========================================================
-- Seltigo - Kargo entegrasyonu (bizim şirketimizi gerektirmez; satıcının kendi hesabıyla)
-- Üç yol, hepsi otomatik:
--   1) Pazaryeri siparişi: etiket pazaryerinin anlaşmalı kargosundan (ör. Trendyol) API ile
--   2) Kendi anlaşması olan satıcı: Yurtiçi, Aras, MNG, PTT, Sürat, HepsiJet (satıcının hesap bilgileri kasada)
--   3) Anlaşması olmayan satıcı: kargo aracı platformu (Geliver, Basit Kargo ...)
-- Gönderi oluşturma, etiket PDF'i, takip numarası -> sipariş + müşteri takip sayfası (shipping-hub).
-- =========================================================

create table if not exists public.shipping_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('geliver', 'basitkargo', 'yurtici', 'aras', 'mng', 'ptt', 'surat', 'hepsijet')),
  mode text not null default 'live' check (mode in ('test', 'live')),
  is_default boolean not null default false,
  account_name text,
  settings jsonb not null default '{}'::jsonb,   -- gizli olmayan ayarlar (gönderici adresi, Geliver gönderici adres no ...)
  credentials_secret_id uuid,                   -- anahtar / şifre: Vault
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, mode)
);
create unique index if not exists shipping_accounts_one_default on public.shipping_accounts (user_id) where is_default;

alter table public.shipping_accounts enable row level security;
drop policy if exists own_shipping_accounts_select on public.shipping_accounts;
create policy own_shipping_accounts_select on public.shipping_accounts for select to authenticated using (user_id = auth.uid());

create or replace function public.shipping_account_set_credentials(p_account_id uuid, p_credentials jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_secret_id uuid;
begin
  select credentials_secret_id into v_secret_id from public.shipping_accounts where id = p_account_id;
  if not found then raise exception 'Kargo hesabı bulunamadı: %', p_account_id; end if;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_credentials::text, 'shipping_acc_' || p_account_id::text, 'Kargo hesap bilgileri');
    update public.shipping_accounts set credentials_secret_id = v_secret_id where id = p_account_id;
  else
    perform vault.update_secret(v_secret_id, p_credentials::text);
  end if;
end; $$;

create or replace function public.shipping_account_get_credentials(p_account_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select ds.decrypted_secret::jsonb from public.shipping_accounts a
  join vault.decrypted_secrets ds on ds.id = a.credentials_secret_id where a.id = p_account_id;
$$;

revoke all on function public.shipping_account_set_credentials(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.shipping_account_get_credentials(uuid) from public, anon, authenticated;
grant execute on function public.shipping_account_set_credentials(uuid, jsonb) to service_role;
grant execute on function public.shipping_account_get_credentials(uuid) to service_role;

create or replace function public.shipping_accounts_cleanup_secret()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.credentials_secret_id is not null then delete from vault.secrets where id = old.credentials_secret_id; end if;
  return old;
end; $$;
drop trigger if exists trg_shipping_accounts_cleanup on public.shipping_accounts;
create trigger trg_shipping_accounts_cleanup after delete on public.shipping_accounts
  for each row execute function public.shipping_accounts_cleanup_secret();

-- Gönderiler
create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  store_order_id uuid references public.store_orders(id) on delete set null,
  marketplace_order_id uuid,                     -- pazaryeri siparişi (etiket pazaryerinden)
  account_id uuid references public.shipping_accounts(id) on delete set null,
  provider text not null,                        -- geliver | yurtici | ... | trendyol
  test boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'created', 'shipped', 'delivered', 'cancelled', 'error')),
  provider_ref text,                             -- sağlayıcının gönderi numarası (Yurtiçi cargoKey, Geliver shipment id ...)
  tracking_number text,
  tracking_url text,
  carrier text,                                  -- taşıyan firma (Geliver'de seçilen firma)
  label_path text,                               -- etiket PDF'i (depo yolu)
  cost numeric,
  currency text,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shipments_one_per_store_order on public.shipments (store_order_id) where store_order_id is not null and status <> 'cancelled';
create index if not exists shipments_queue_idx on public.shipments (next_attempt_at) where status in ('pending', 'created', 'shipped');

alter table public.shipments enable row level security;
drop policy if exists own_shipments_select on public.shipments;
create policy own_shipments_select on public.shipments for select to authenticated using (user_id = auth.uid());

-- Satıcı ayarı: kendi gönderdiği siparişlerde gönderi otomatik oluşturulsun (varsayılan açık)
alter table public.user_profiles
  add column if not exists shipping_auto boolean not null default true;

-- Mağaza siparişi -> gönderi kuyruğu (yalnız satıcının kendi gönderdiği ürünler: Kendi stoğum / Toptancı;
-- AliExpress / CJ ürünlerini tedarikçi gönderir). Varsayılan kargo hesabı yoksa iş açılmaz.
create or replace function public.store_order_to_shipment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_supplier text;
  v_account uuid;
  v_auto boolean;
begin
  select p.supplier into v_supplier from public.products p where p.id = new.product_id;
  if v_supplier in ('aliexpress', 'cj', 'printify') then return new; end if;
  select coalesce(shipping_auto, true) into v_auto from public.user_profiles where user_id = new.user_id;
  if v_auto is false then return new; end if;
  select id into v_account from public.shipping_accounts where user_id = new.user_id and is_default and status = 'connected';
  if v_account is null then return new; end if;
  insert into public.shipments (user_id, store_order_id, account_id, provider, test)
  select new.user_id, new.id, a.id, a.provider, a.mode = 'test' from public.shipping_accounts a where a.id = v_account
  on conflict do nothing;
  return new;
exception when others then
  raise warning 'store_order_to_shipment: %', sqlerrm;
  return new;
end; $$;

drop trigger if exists trg_store_order_to_shipment on public.store_orders;
create trigger trg_store_order_to_shipment after insert on public.store_orders
  for each row execute function public.store_order_to_shipment();

-- Etiket PDF'leri: özel depo (yalnız sahibi indirir)
insert into storage.buckets (id, name, public) values ('shipping-labels', 'shipping-labels', false)
on conflict (id) do nothing;
drop policy if exists own_labels_read on storage.objects;
create policy own_labels_read on storage.objects for select to authenticated
  using (bucket_id = 'shipping-labels' and (storage.foldername(name))[1] = auth.uid()::text);
