-- =========================================================
-- Seltigo - Tedarikçi hesap bağlantıları (AliExpress; ileride diğerleri)
-- Satıcı kendi tedarikçi hesabını OAuth ile bağlar; anahtarlar şifreli kasada (Vault).
-- Satıcı sadece bağlantı durumunu görür, anahtarları göremez.
-- =========================================================

create table if not exists public.supplier_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier text not null check (supplier in ('aliexpress')),
  account_name text,
  external_account_id text,
  credentials_secret_id uuid,
  token_expires_at timestamptz,
  refresh_expires_at timestamptz,
  status text not null default 'connected' check (status in ('connected', 'expired', 'error')),
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, supplier)
);

alter table public.supplier_connections enable row level security;

drop policy if exists own_supplier_connections_select on public.supplier_connections;
create policy own_supplier_connections_select on public.supplier_connections
  for select to authenticated using (user_id = auth.uid());

-- Kasadaki anahtarlar: sadece sunucu (service_role) okuyup yazabilir
create or replace function public.supplier_connection_set_credentials(p_connection_id uuid, p_credentials jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select credentials_secret_id into v_secret_id from public.supplier_connections where id = p_connection_id;
  if not found then
    raise exception 'Bağlantı bulunamadı: %', p_connection_id;
  end if;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_credentials::text, 'supplier_conn_' || p_connection_id::text, 'Tedarikçi hesap anahtarları');
    update public.supplier_connections set credentials_secret_id = v_secret_id where id = p_connection_id;
  else
    perform vault.update_secret(v_secret_id, p_credentials::text);
  end if;
end;
$$;

create or replace function public.supplier_connection_get_credentials(p_connection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select ds.decrypted_secret::jsonb
  from public.supplier_connections sc
  join vault.decrypted_secrets ds on ds.id = sc.credentials_secret_id
  where sc.id = p_connection_id;
$$;

revoke all on function public.supplier_connection_set_credentials(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.supplier_connection_get_credentials(uuid) from public, anon, authenticated;
grant execute on function public.supplier_connection_set_credentials(uuid, jsonb) to service_role;
grant execute on function public.supplier_connection_get_credentials(uuid) to service_role;

-- Bağlantı silinince kasadaki anahtar da silinir
create or replace function public.supplier_connections_cleanup_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.credentials_secret_id is not null then
    delete from vault.secrets where id = old.credentials_secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_supplier_connections_cleanup on public.supplier_connections;
create trigger trg_supplier_connections_cleanup
  after delete on public.supplier_connections
  for each row execute function public.supplier_connections_cleanup_secret();

-- Satıcının seçtiği tedarikçi seçeneği (AliExpress sku_attr; sipariş için gerekli)
alter table public.products
  add column if not exists supplier_sku_attr text;

-- Siparişte kullanılan tedarikçi kargo yöntemi (CJ/AliExpress)
alter table public.orders
  add column if not exists supplier_logistics text;
