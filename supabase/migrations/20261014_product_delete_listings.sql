-- =========================================================
-- Ürün silinince (deleted_at) ilanları da yayından kalkar (status = 'removed'):
-- vitrinde görünmez, pazaryerlerinden kaldırma işi kuyruğa düşer (listings_enqueue_sync durum değişikliğini görür).
-- Ürün geri alınırsa (deleted_at = null) ilanlar kendiliğinden geri gelmez (satıcı yeniden yayınlar).
-- + Geçmişte silinmiş ürünlerin hâlâ "yayında" görünen ilanları temizlenir.
-- =========================================================
create or replace function public.products_soft_delete_listings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.listings set status = 'removed', updated_at = now()
    where product_id = new.id and status in ('published', 'pending', 'paused', 'out_of_stock', 'error') and deleted_at is null;
    update public.products set store_visible = false where id = new.id and store_visible is distinct from false;
  end if;
  return new;
exception when others then
  raise warning 'products_soft_delete_listings: %', sqlerrm;
  return new;
end $$;
drop trigger if exists trg_products_soft_delete_listings on public.products;
create trigger trg_products_soft_delete_listings after update of deleted_at on public.products
for each row execute function public.products_soft_delete_listings();

-- Eski kayıtlar: silinmiş ürünlerin Kendi Mağazam ilanları (dış pazaryeri ilanları kuyruk üzerinden kaldırılsın diye ayrı)
update public.listings l set status = 'removed', updated_at = now()
from public.products p
where p.id = l.product_id and p.deleted_at is not null and l.deleted_at is null and l.status = 'published';
