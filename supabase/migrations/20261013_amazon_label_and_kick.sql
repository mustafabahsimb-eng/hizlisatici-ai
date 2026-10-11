-- =========================================================
-- 1) Amazon siparişi -> otomatik gönderi (etiket)
--    Satıcının kendi gönderdiği ürün (Kendi stoğum / Toptancı) + alıcı adresi var:
--      varsayılan kargo hesabı varsa onunla; yoksa Amazon "Buy Shipping" (provider 'amazon'; desteklenen pazarlarda,
--      bağlantı ayarı buy_shipping=false değilse). AliExpress / CJ ürünlerini tedarikçi gönderir.
-- 2) HIZ: ilan kuyruğuna iş düşünce sync-worker beklemeden çalışır (2 dk'lık görevi beklemez; en fazla 5 sn'de bir)
-- =========================================================
create unique index if not exists shipments_one_per_mp_order on public.shipments (marketplace_order_id)
  where marketplace_order_id is not null and status <> 'cancelled';

create or replace function public.marketplace_order_to_shipment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_supplier text; v_auto boolean; v_acc record; v_buy text;
begin
  if new.marketplace_code not like 'amazon\_%' or new.status <> 'new' or new.product_id is null then return new; end if;
  if coalesce(new.buyer_address->>'line1', '') = '' then return new; end if;  -- adres yoksa (kişisel veri izni) etiket alınamaz
  select supplier into v_supplier from public.products where id = new.product_id;
  if v_supplier in ('aliexpress', 'cj', 'printify') then return new; end if;
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
drop trigger if exists trg_marketplace_order_to_shipment on public.marketplace_orders;
create trigger trg_marketplace_order_to_shipment after insert on public.marketplace_orders
for each row execute function public.marketplace_order_to_shipment();

-- 2) sync-worker'ı hemen çalıştır (komut, gizli anahtarla birlikte zaten zamanlanmış görevde duruyor; dışarı çıkmaz)
create table if not exists public.sync_kick_state (id int primary key default 1 check (id = 1), last_kick timestamptz not null default 'epoch');
insert into public.sync_kick_state (id) values (1) on conflict do nothing;
alter table public.sync_kick_state enable row level security;

create or replace function public.sync_jobs_kick()
returns trigger language plpgsql security definer set search_path = public, cron as $$
declare v_cmd text; v_ok boolean;
begin
  update public.sync_kick_state set last_kick = now() where id = 1 and last_kick < now() - interval '5 seconds' returning true into v_ok;
  if v_ok is not true then return null; end if;
  select command into v_cmd from cron.job where jobname = 'sync-worker-every-2-min';
  if v_cmd is not null then execute v_cmd; end if;
  return null;
exception when others then
  raise warning 'sync_jobs_kick: %', sqlerrm;
  return null;
end $$;
drop trigger if exists trg_sync_jobs_kick on public.sync_jobs;
create trigger trg_sync_jobs_kick after insert on public.sync_jobs
for each statement execute function public.sync_jobs_kick();
