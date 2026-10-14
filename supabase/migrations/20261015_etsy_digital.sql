-- =========================================================
-- Dijital ürün + indirilebilir dosyalar + Etsy
-- - products.product_type: physical | digital ("Fiziksel ürün" / "Dijital ürün")
-- - product_files: ürün başına en fazla 5 dosya, dosya başı en fazla 20 MB (Etsy sınırı); özel depo product-files
-- - Dijital üründe kargo gönderisi açılmaz
-- - app_cache: sunucu önbelleği (Etsy kategori numarası vb.)
-- =========================================================
alter table public.products add column if not exists product_type text not null default 'physical';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_product_type_check') then
    alter table public.products add constraint products_product_type_check check (product_type in ('physical', 'digital'));
  end if;
end $$;

create table if not exists public.product_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  path text not null,                    -- product-files/<user>/<product>/<dosya>
  name text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  mime text,
  rank int not null default 1 check (rank between 1 and 5),
  created_at timestamptz not null default now(),
  unique (product_id, rank)
);
create index if not exists product_files_product_idx on public.product_files (product_id);
alter table public.product_files enable row level security;
drop policy if exists own_product_files on public.product_files;
create policy own_product_files on public.product_files for all to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.products p where p.id = product_id and p.user_id = auth.uid()));

create or replace function public.product_files_limit()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.product_files where product_id = new.product_id) >= 5 then
    raise exception 'Bir ürüne en fazla 5 dosya eklenebilir';
  end if;
  return new;
end $$;
drop trigger if exists trg_product_files_limit on public.product_files;
create trigger trg_product_files_limit before insert on public.product_files for each row execute function public.product_files_limit();

-- Özel depo: 20 MB sınır, satıcı yalnız kendi klasörü
insert into storage.buckets (id, name, public, file_size_limit) values ('product-files', 'product-files', false, 20971520)
on conflict (id) do update set file_size_limit = 20971520, public = false;
drop policy if exists own_product_files_read on storage.objects;
create policy own_product_files_read on storage.objects for select to authenticated using (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists own_product_files_write on storage.objects;
create policy own_product_files_write on storage.objects for insert to authenticated with check (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists own_product_files_delete on storage.objects;
create policy own_product_files_delete on storage.objects for delete to authenticated using (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- Dijital ürün siparişinde kargo gönderisi açılmaz (tüm gönderi tetikleyicileri için tek yerde)
create or replace function public.shipments_skip_digital()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pid bigint;
begin
  if coalesce(new.kind, 'outbound') <> 'outbound' then return new; end if;
  if new.store_order_id is not null then select product_id into v_pid from public.store_orders where id = new.store_order_id;
  elsif new.marketplace_order_id is not null then select product_id into v_pid from public.marketplace_orders where id = new.marketplace_order_id;
  end if;
  if v_pid is not null and exists (select 1 from public.products where id = v_pid and product_type = 'digital') then return null; end if;
  return new;
end $$;
drop trigger if exists trg_shipments_skip_digital on public.shipments;
create trigger trg_shipments_skip_digital before insert on public.shipments for each row execute function public.shipments_skip_digital();

create table if not exists public.app_cache (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_cache enable row level security;   -- yalnız sunucu

update public.marketplaces set currency = coalesce(currency, 'USD'), max_images = coalesce(max_images, 10) where code = 'etsy';

insert into public.feature_flags (key, name_tr) values
  ('digital_products', 'Dijital ürün ve indirilebilir dosyalar'),
  ('etsy', 'Etsy bağlantısı ve ilan gönderme'),
  ('folder_import', 'Klasörden toplu yükleme')
on conflict (key) do nothing;
