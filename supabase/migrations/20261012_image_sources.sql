-- Görsel telif güvencesi: her görselin kaynağı ve satıcının ilk kullanım onayı.
-- source_kind: catalog (yüklenen dosya), link (çekilen sayfa), brand_media_kit, brand_site,
--              wholesaler, cj, aliexpress, seller_photo (satıcının kendi fotoğrafı)

alter table public.product_images
  add column if not exists source_kind text,
  add column if not exists source_url  text;   -- görselin alındığı sayfa (satıcıya "Görsel kaynağı: ..." olarak gösterilir)

-- "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir" onayı (bir kez, tarihiyle)
alter table public.user_profiles
  add column if not exists image_terms_accepted_at timestamptz,
  add column if not exists image_terms_text text;

-- Görseli olmayan ürün ("Görsel eksik")
alter table public.products
  add column if not exists image_missing boolean not null default false;
