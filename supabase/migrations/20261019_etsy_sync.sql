-- =========================================================
-- Etsy senkronu: bağlı Etsy mağazasındaki TÜM ilanlar Seltigo ürün listesine (Printify'dan / Etsy panelinden eklenenler dahil)
-- - Dışarıda yönetilen ilan: listings.attributes.managed_by = 'printify' | 'etsy'. Bu ilanlar Seltigo'nun gönderim kuyruğuna GİRMEZ
--   (Seltigo onları Etsy'ye geri yazmaz; Printify'ın beden bazlı fiyatları ezilmez). Etsy'de silinen ilan validation.etsy.state = 'removed'.
-- - products.fixed_fee: satış başına sabit pazaryeri ücreti (ürün para biriminde; Etsy: ilan 0,20 $ + ödeme 0,25 $). Panel net kârdan düşer.
-- Paket anahtarı: etsy_sync (varsayılan açık)
-- =========================================================
alter table public.products add column if not exists fixed_fee numeric;
comment on column public.products.fixed_fee is 'Satış başına sabit pazaryeri ücreti (ürün para biriminde). Etsy: ilan 0,20 $ + ödeme 0,25 $';

create or replace function public.listings_enqueue_sync()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  if new.user_id is null then
    return new;
  end if;

  -- Dışarıda yönetilen ilan (Printify / Etsy panelinden içe aktarılan): Seltigo pazaryerine geri yazmaz
  if coalesce(new.attributes->>'managed_by', '') <> '' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'published' or new.deleted_at is not null then
      return new;
    end if;
  else
    if new.status                  is not distinct from old.status
       and new.deleted_at          is not distinct from old.deleted_at
       and new.title               is not distinct from old.title
       and new.description         is not distinct from old.description
       and new.price               is not distinct from old.price
       and new.compare_at_price    is not distinct from old.compare_at_price
       and new.bullet_points       is not distinct from old.bullet_points
       and new.keywords            is not distinct from old.keywords
       and new.attributes          is not distinct from old.attributes
       and new.marketplace_category_id is not distinct from old.marketplace_category_id
       and new.marketplace_brand_id    is not distinct from old.marketplace_brand_id
       and new.connection_id       is not distinct from old.connection_id
    then
      return new;
    end if;

    if old.status = 'draft' and new.status = 'draft' then
      return new;
    end if;
  end if;

  perform public.enqueue_sync_job(
    new.user_id,
    'listing_sync',
    new.id,
    new.connection_id,
    jsonb_build_object('reason', lower(tg_op), 'status', new.status),
    'listing:' || new.id::text,
    case when new.status = 'published' and new.deleted_at is null then 50 else 60 end
  );

  return new;
end;
$function$;

create or replace function public.products_enqueue_stock_sync()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  if new.stock_qty is not distinct from old.stock_qty
     and new.stock_status is not distinct from old.stock_status then
    return new;
  end if;

  perform public.enqueue_sync_job(
    l.user_id,
    'listing_sync',
    l.id,
    l.connection_id,
    jsonb_build_object('reason', 'stock', 'stock_qty', new.stock_qty, 'stock_status', new.stock_status),
    'listing:' || l.id::text,
    40
  )
  from public.listings l
  where l.product_id = new.id
    and l.status = 'published'
    and l.deleted_at is null
    and coalesce(l.attributes->>'managed_by', '') = '';   -- dışarıda yönetilen ilanlar hariç

  return new;
end;
$function$;

insert into public.feature_flags (key, name_tr, note) values
  ('etsy_sync', 'Etsy mağazasındaki tüm ilanları içe aktarma ve senkron', 'Printify maliyeti ve gerçek net kâr dahil')
on conflict (key) do nothing;
