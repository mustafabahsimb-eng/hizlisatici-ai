-- =========================================================
-- Ücretli olabilecek özellikler: TEK YERDEN aç / kapa (paketler belirlenene kadar hepsi AÇIK)
-- feature_flags: özellik başına genel anahtar + (ileride) hangi paketlerde olduğu
-- user_feature_overrides: tek satıcıya özel aç/kapa (hediye, deneme, ceza)
-- feature_enabled(user, key): sunucu (Edge Functions) ve panel (HS.feature) aynı fonksiyonu kullanır
-- Kayıtsız anahtar = açık (yeni özellik unutulursa kimse kilitlenmez).
-- =========================================================
create table if not exists public.feature_flags (
  key text primary key,
  name_tr text not null,
  enabled boolean not null default true,      -- genel anahtar (false = herkese kapalı)
  plans text[],                               -- null = tüm paketler; ör. {pro,business} = yalnız bu paketler
  note text,
  updated_at timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
drop policy if exists flags_read on public.feature_flags;
create policy flags_read on public.feature_flags for select to anon, authenticated using (true);

create table if not exists public.user_feature_overrides (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null references public.feature_flags(key) on delete cascade,
  enabled boolean not null,
  expires_at timestamptz,
  note text,
  primary key (user_id, key)
);
alter table public.user_feature_overrides enable row level security;
drop policy if exists own_overrides_read on public.user_feature_overrides;
create policy own_overrides_read on public.user_feature_overrides for select to authenticated using (user_id = auth.uid());

create or replace function public.feature_enabled(p_user uuid, p_key text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare f record; o record; v_plan text;
begin
  select * into f from public.feature_flags where key = p_key;
  if not found then return true; end if;
  if not f.enabled then return false; end if;
  select * into o from public.user_feature_overrides where user_id = p_user and key = p_key and (expires_at is null or expires_at > now());
  if found then return o.enabled; end if;
  if f.plans is null then return true; end if;
  select plan into v_plan from public.user_memberships where user_id = p_user and (expires_at is null or expires_at > now());
  return v_plan is not null and v_plan = any(f.plans);
end $$;
revoke all on function public.feature_enabled(uuid, text) from public;
grant execute on function public.feature_enabled(uuid, text) to service_role, authenticated;

-- Panel için: oturumdaki kullanıcının tüm anahtarları tek seferde
create or replace function public.my_features()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(key, public.feature_enabled(auth.uid(), key)), '{}'::jsonb) from public.feature_flags;
$$;
grant execute on function public.my_features() to authenticated;

insert into public.feature_flags (key, name_tr, note) values
  ('assistant', 'Seltigo Asistan (Telegram)', null),
  ('assistant_whatsapp', 'Seltigo Asistan WhatsApp sürümü', 'ayrı ücretli paket; aylık mesaj sınırı assistant_settings.whatsapp_monthly_limit'),
  ('assistant_voice', 'Asistan sesli komut', 'STT servisi ücretli (STT_API_KEY)'),
  ('multi_channel', 'Diğer kanallara gönderim (çok kanal)', 'Link ver mağazan hazır: giriş ücretsiz, çok kanal ücretli olabilir'),
  ('site_import', 'Siteden mağaza kurma (Link ver, mağazan hazır)', null),
  ('link_import', 'Linkten ürün yükleme', null),
  ('catalog_import', 'Katalog / fiyat listesi yükleme (AI okuma)', null),
  ('image_complete', 'Arka planda görsel tamamlama', null),
  ('ai_copy', 'Metni kanala göre yaz (AI)', null),
  ('source_sync', 'Fiyat ve stoğu otomatik güncel tut', null),
  ('amazon', 'Amazon bağlantısı', null),
  ('marketplace_orders', 'Pazaryeri siparişlerini otomatik çekme', null),
  ('shipping_labels', 'Otomatik kargo gönderisi ve etiket', null),
  ('supplier_autoorder', 'Tedarikçiye otomatik sipariş (CJ / AliExpress)', null),
  ('wa_customer_notify', 'Müşteriye otomatik WhatsApp bildirimi', null),
  ('instagram_autopost', 'Instagram otomatik paylaşım', null),
  ('meta_catalog', 'WhatsApp ve Instagram kataloğu', null),
  ('returns_auto', 'İade otomasyonu', null),
  ('ads', 'Seltigo Ads (reklam otomasyonu)', null),
  ('content_auto', 'İçerik otomasyonu', null),
  ('chrome_extension', 'Chrome eklentisi', null)
on conflict (key) do nothing;

-- ---------------------------------------------------------
-- Tetikleyicilere anahtar: tedarikçiye otomatik sipariş (supplier_autoorder), otomatik kargo (shipping_labels)
-- ---------------------------------------------------------
create or replace function public.store_order_to_supplier_order()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_supplier text;
begin
  select p.supplier into v_supplier from public.products p where p.id = new.product_id;
  -- Ürün kaynağı kuralı: yalnız AliExpress / CJ kaynaklı ürünlerin siparişi tedarikçiye gider.
  if v_supplier is null or v_supplier not in ('aliexpress', 'cj') then return new; end if;
  if not public.feature_enabled(new.user_id, 'supplier_autoorder') then return new; end if;
  if exists (select 1 from public.orders o where o.user_id = new.user_id and (o.store_order_id = new.id or o.marketplace_order_no = 'store-' || new.id::text)) then
    return new;
  end if;
  insert into public.orders (
    user_id, product_id, platform, marketplace_order_no, store_order_id,
    customer_name, customer_phone, customer_address, customer_city,
    customer_district, customer_zip, customer_country,
    quantity, unit_price, currency, supplier, status, note, variant_id, variant_label
  ) values (
    new.user_id, new.product_id, 'own_store', 'store-' || new.id::text, new.id,
    new.customer_name, new.customer_phone, new.customer_address, new.customer_city,
    new.customer_district, new.customer_zip, coalesce(new.customer_country, 'TR'),
    greatest(1, least(99, coalesce(new.quantity, 1))), new.unit_price, new.currency,
    v_supplier, 'beklemede', '🏪 Mağaza siparişinden otomatik hazırlandı', new.variant_id, new.variant_label
  );
  return new;
exception when others then
  raise warning 'store_order_to_supplier_order: %', sqlerrm;
  return new;
end;
$function$;

create or replace function public.store_order_to_shipment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_supplier text;
  v_account uuid;
  v_auto boolean;
begin
  select p.supplier into v_supplier from public.products p where p.id = new.product_id;
  if v_supplier in ('aliexpress', 'cj', 'printify') then return new; end if;
  if not public.feature_enabled(new.user_id, 'shipping_labels') then return new; end if;
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

create or replace function public.marketplace_order_to_supplier_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_supplier text;
begin
  if new.marketplace_code not like 'amazon\_%' or new.product_id is null or new.status <> 'new' then return new; end if;
  select supplier into v_supplier from public.products where id = new.product_id;
  if v_supplier is null or v_supplier not in ('aliexpress', 'cj') then return new; end if;
  if not public.feature_enabled(new.user_id, 'supplier_autoorder') then return new; end if;
  if exists (select 1 from public.orders o where o.user_id = new.user_id and o.marketplace_order_no = new.external_order_id and o.product_id = new.product_id) then return new; end if;
  insert into public.orders (user_id, product_id, platform, marketplace_order_no, customer_name, customer_phone, customer_address, customer_city,
    customer_district, customer_zip, customer_country, quantity, unit_price, currency, supplier, status, hold_reason, note, variant_id)
  values (new.user_id, new.product_id, new.marketplace_code, new.external_order_id, new.buyer_name, new.buyer_phone,
    concat_ws(' ', new.buyer_address->>'line1', new.buyer_address->>'line2', new.buyer_address->>'line3'), new.buyer_address->>'city',
    new.buyer_address->>'district', new.buyer_address->>'zip', coalesce(new.buyer_country::text, new.buyer_address->>'country', 'TR'),
    greatest(1, least(99, new.quantity)), new.item_price, new.currency, v_supplier,
    case when coalesce(new.buyer_address->>'line1', '') = '' then 'onay_bekliyor' else 'beklemede' end,
    case when coalesce(new.buyer_address->>'line1', '') = '' then 'adres_yok' end,
    case when coalesce(new.buyer_address->>'line1', '') = '' then '🟡 Amazon alıcı adresi gelmedi (uygulamada kişisel veri izni gerekli)' else '🟡 Amazon siparişinden otomatik hazırlandı' end,
    new.variant_id);
  return new;
exception when others then
  raise warning 'marketplace_order_to_supplier_order: %', sqlerrm;
  return new;
end $$;

create or replace function public.marketplace_order_to_shipment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_supplier text; v_auto boolean; v_acc record; v_buy text;
begin
  if new.marketplace_code not like 'amazon\_%' or new.status <> 'new' or new.product_id is null then return new; end if;
  if coalesce(new.buyer_address->>'line1', '') = '' then return new; end if;  -- adres yoksa (kişisel veri izni) etiket alınamaz
  select supplier into v_supplier from public.products where id = new.product_id;
  if v_supplier in ('aliexpress', 'cj', 'printify') then return new; end if;
  if not public.feature_enabled(new.user_id, 'shipping_labels') then return new; end if;
  select coalesce(shipping_auto, true) into v_auto from public.user_profiles where user_id = new.user_id;
  if v_auto is false then return new; end if;
  select id, provider, mode into v_acc from public.shipping_accounts where user_id = new.user_id and is_default and status = 'connected' limit 1;
  if v_acc.id is not null then
    insert into public.shipments (user_id, marketplace_order_id, account_id, provider, test)
    values (new.user_id, new.id, v_acc.id, v_acc.provider, v_acc.mode = 'test') on conflict do nothing;
    return new;
  end if;
  -- Amazon Buy Shipping'in olduğu pazarlar (Merchant Fulfillment API)
  if new.marketplace_code in ('amazon_us', 'amazon_ca', 'amazon_uk', 'amazon_de', 'amazon_fr', 'amazon_it', 'amazon_es', 'amazon_jp', 'amazon_au') then
    select settings->>'buy_shipping' into v_buy from public.store_connections where id = new.connection_id;
    if coalesce(v_buy, 'true') <> 'false' then
      insert into public.shipments (user_id, marketplace_order_id, account_id, provider, test)
      values (new.user_id, new.id, null, 'amazon', false) on conflict do nothing;
    end if;
  end if;
  return new;
exception when others then
  raise warning 'marketplace_order_to_shipment: %', sqlerrm;
  return new;
end $$;
