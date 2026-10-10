-- =========================================================
-- Seltigo - AliExpress ürünlerine CJ eşdeğeri (otomatik ödeme için yedek yol)
-- AliExpress'in API ile ödemesi (API Pay) her satıcıda açık değil (Türkiye desteklenmiyor).
-- cj-alt-match, AliExpress ürününün CJ'deki eşdeğerini arka planda bulur (görselle arama,
-- olmazsa CJ sourcing talebi). Sipariş işçisi, AliExpress ödemesi yapılamayan satıcılarda
-- siparişi CJ'den verip CJ bakiyesinden öder.
-- =========================================================

alter table public.products
  add column if not exists cj_alt_status text check (cj_alt_status in ('searching', 'sourcing', 'found', 'not_found', 'error')),
  add column if not exists cj_alt_source text,
  add column if not exists cj_alt_pid text,
  add column if not exists cj_alt_vid text,
  add column if not exists cj_alt_sourcing_id text,
  add column if not exists cj_alt_cost_usd numeric,
  add column if not exists cj_alt_note text,
  add column if not exists cj_alt_checked_at timestamptz;

create index if not exists products_cj_alt_idx on public.products (cj_alt_status) where supplier = 'aliexpress';

-- Satıcının AliExpress API ile ödeme durumu: unknown (denenmedi) / yes / no
alter table public.supplier_connections
  add column if not exists api_pay text not null default 'unknown' check (api_pay in ('unknown', 'yes', 'no'));

-- Siparişin fiilen verildiği tedarikçi (AliExpress ürünü CJ'den verilebilir)
alter table public.orders
  add column if not exists fulfilled_via text;
