-- Linkten ürün yükleme: ürünün geldiği kaynak ve otomatik fiyat/stok takibi.
-- product-import platformu ve kaynak numarasını döndürür; Toplu Ürün Yükleme bunları kaydeder.
-- source-sync (zamanlanmış görev) source_sync açık ürünlerin fiyat/stoğunu kaynaktan günceller.

alter table public.products
  add column if not exists source_platform   text,          -- aliexpress | shopify | woocommerce | trendyol | web | feed
  add column if not exists source_item_id    text,          -- kaynaktaki ürün numarası
  add column if not exists source_sync       boolean not null default false, -- "Fiyat ve stoğu otomatik güncel tut"
  add column if not exists source_sync_hours int not null default 24 check (source_sync_hours in (6, 24)),
  add column if not exists source_checked_at timestamptz,
  add column if not exists source_note       text;

create index if not exists products_source_sync_idx
  on public.products (source_checked_at nulls first)
  where source_sync and deleted_at is null;

-- Varyantın kaynaktaki kodu (bizim sku'muz kullanıcı başına tekil olduğu için ayrı tutulur)
alter table public.product_variants
  add column if not exists supplier_sku text;
