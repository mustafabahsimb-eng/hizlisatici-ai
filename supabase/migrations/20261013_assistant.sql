-- =========================================================
-- Seltigo Asistan ("Mağazanı WhatsApp'tan yönet")
-- Tek çekirdek (_shared/assistant-core.ts), kanal bağlayıcıları: Telegram (canlı), WhatsApp (Seltigo numarası;
-- Meta test numarasıyla, şirketle canlı), Instagram DM / Messenger (sandbox, varsayılan kapalı).
-- Güvenlik: yalnız bağlanmış (doğrulanmış) hesap komut verir; rol yetkisi; kritik işte ikinci onay; sessiz saatler.
-- =========================================================

-- Bağlı sohbet hesapları (satıcı ve çalışanları)
create table if not exists public.assistant_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('telegram', 'whatsapp', 'instagram', 'messenger', 'test')),
  external_id text not null,                 -- Telegram sohbet no / WhatsApp telefon / Instagram-Messenger kullanıcı no
  display_name text,
  role text not null default 'full' check (role in ('full', 'products', 'orders')),  -- Tam yetki / Ürün ekleyebilir / Sadece siparişler
  is_owner boolean not null default true,
  last_inbound_at timestamptz,               -- Meta 24 saat penceresi için
  created_at timestamptz not null default now(),
  unique (channel, external_id)
);
alter table public.assistant_links enable row level security;
drop policy if exists own_links_select on public.assistant_links;
create policy own_links_select on public.assistant_links for select to authenticated using (user_id = auth.uid());
drop policy if exists own_links_delete on public.assistant_links;
create policy own_links_delete on public.assistant_links for delete to authenticated using (user_id = auth.uid());
drop policy if exists own_links_update on public.assistant_links;
create policy own_links_update on public.assistant_links for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Tek kullanımlık bağlama kodları (panelde üretilir, sohbetten gönderilir)
create table if not exists public.assistant_link_codes (
  code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null,
  role text not null default 'full',
  is_owner boolean not null default true,
  expires_at timestamptz not null default now() + interval '30 minutes',
  used_at timestamptz
);
alter table public.assistant_link_codes enable row level security;
drop policy if exists own_codes_select on public.assistant_link_codes;
create policy own_codes_select on public.assistant_link_codes for select to authenticated using (user_id = auth.uid());

-- Asistan ayarları (bir kez girilir; HIZ KURALI)
create table if not exists public.assistant_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  approval_mode text not null default 'direct' check (approval_mode in ('direct', 'approve')),  -- direkt yayınla / yayından önce onay iste
  default_channels text[] not null default array['own_store'],
  quiet_start time not null default '22:00',
  quiet_end time not null default '08:00',
  morning_report boolean not null default true,
  weekly_summary boolean not null default true,
  whatsapp_plan boolean not null default false,   -- WhatsApp sürümü ayrı ücretli paket
  whatsapp_monthly_limit int not null default 1000,
  updated_at timestamptz not null default now()
);
alter table public.assistant_settings enable row level security;
drop policy if exists own_asettings_all on public.assistant_settings;
create policy own_asettings_all on public.assistant_settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Konuşma durumu (önizleme listesi, onay bekleyen kritik iş vb.)
create table if not exists public.assistant_sessions (
  link_id uuid primary key references public.assistant_links(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.assistant_sessions enable row level security;  -- yalnız sunucu

-- Bildirim kuyruğu (yeni sipariş, stok, zararlı sipariş, CJ bakiyesi, bağlantı, rakip fiyat, raporlar)
create table if not exists public.assistant_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create unique index if not exists assistant_outbox_dedupe on public.assistant_outbox (user_id, dedupe_key) where dedupe_key is not null;
create index if not exists assistant_outbox_queue on public.assistant_outbox (send_after) where status = 'pending';
alter table public.assistant_outbox enable row level security;
drop policy if exists own_outbox_select on public.assistant_outbox;
create policy own_outbox_select on public.assistant_outbox for select to authenticated using (user_id = auth.uid());

-- Mesaj sayacı (WhatsApp paket sınırı)
create table if not exists public.assistant_messages (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  channel text not null,
  direction text not null check (direction in ('in', 'out')),
  created_at timestamptz not null default now()
);
create index if not exists assistant_messages_count on public.assistant_messages (user_id, channel, created_at);
alter table public.assistant_messages enable row level security;

-- ---------- Olay -> bildirim ----------
create or replace function public.assistant_enqueue(p_user uuid, p_kind text, p_payload jsonb, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.assistant_links where user_id = p_user) then return; end if;
  insert into public.assistant_outbox (user_id, kind, payload, dedupe_key) values (p_user, p_kind, p_payload, p_dedupe)
  on conflict do nothing;
exception when others then
  raise warning 'assistant_enqueue: %', sqlerrm;
end; $$;
revoke all on function public.assistant_enqueue(uuid, text, jsonb, text) from public, anon, authenticated;

-- Yeni mağaza siparişi
create or replace function public.assistant_on_store_order() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assistant_enqueue(new.user_id, 'new_order',
    jsonb_build_object('store_order_id', new.id, 'product_id', new.product_id, 'quantity', new.quantity, 'unit_price', new.unit_price,
                       'currency', new.currency, 'customer', new.customer_name, 'city', new.customer_city, 'variant', new.variant_label),
    'order:' || new.id::text);
  return new;
end; $$;
drop trigger if exists trg_assistant_store_order on public.store_orders;
create trigger trg_assistant_store_order after insert on public.store_orders for each row execute function public.assistant_on_store_order();

-- Stok azaldı / bitti
create or replace function public.assistant_on_stock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stock_status is distinct from old.stock_status and new.stock_status in ('az', 'tukendi') then
    perform public.assistant_enqueue(new.user_id, 'stock', jsonb_build_object('product_id', new.id, 'name', coalesce(new.generated_title, new.name), 'status', new.stock_status, 'qty', new.stock_qty),
      'stock:' || new.id::text || ':' || new.stock_status || ':' || to_char(now(), 'YYYYMMDD'));
  end if;
  return new;
end; $$;
drop trigger if exists trg_assistant_stock on public.products;
create trigger trg_assistant_stock after update of stock_status on public.products for each row execute function public.assistant_on_stock();

-- Tedarikçi siparişi: zararlı (onay bekliyor) / CJ bakiyesi yetersiz
create or replace function public.assistant_on_supplier_order() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'onay_bekliyor' then
      perform public.assistant_enqueue(new.user_id, 'loss_approval', jsonb_build_object('order_id', new.id, 'reason', new.hold_reason, 'message', new.error_message), 'hold:' || new.id::text || ':' || coalesce(new.hold_reason, ''));
    elsif new.status = 'bakiye_bekliyor' then
      perform public.assistant_enqueue(new.user_id, 'cj_balance', jsonb_build_object('order_id', new.id, 'message', new.error_message), 'balance:' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists trg_assistant_supplier_order on public.orders;
create trigger trg_assistant_supplier_order after update of status on public.orders for each row execute function public.assistant_on_supplier_order();

-- Test kanalı gelen kutusu (otomatik testler: gönderilen bildirimler buraya yazılır)
create table if not exists public.assistant_test_inbox (
  id bigint generated always as identity primary key,
  user_id uuid,
  external_id text,
  reply jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.assistant_test_inbox enable row level security;
drop policy if exists own_test_inbox_select on public.assistant_test_inbox;
create policy own_test_inbox_select on public.assistant_test_inbox for select to authenticated using (user_id = auth.uid());
-- Zamanlanmış görevler (CRON_SECRET'lı komut mevcut bir işten kopyalanarak kuruldu): assistant-outbox-1min, assistant-reports-daily (05:00 UTC = 08:00 TR), assistant-connections-daily
