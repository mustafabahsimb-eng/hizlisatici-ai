-- =========================================================
-- İade otomasyonu (R1-R4): talep -> AI sınıflandırma + kurallar -> onay -> iade etiketi -> teslim alındı -> stok -> para iadesi
-- Kaynaklar: Kendi Mağazam (takip sayfası formu), pazaryerleri (Trendyol claims, n11 ReturnService), tedarikçi anlaşmazlığı (CJ dispute)
-- Paket anahtarı: returns_auto (feature_flags)
-- =========================================================
create table if not exists public.returns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'own_store',            -- own_store | trendyol_tr | n11_tr | ...
  external_id text,                                    -- pazaryeri iade / claim numarası
  store_order_id uuid references public.store_orders(id) on delete set null,
  marketplace_order_id uuid references public.marketplace_orders(id) on delete set null,
  supplier_order_id uuid references public.orders(id) on delete set null,
  product_id bigint references public.products(id) on delete set null,
  variant_id uuid,
  quantity int not null default 1 check (quantity > 0),
  reason_code text not null default 'other' check (reason_code in ('size', 'changed_mind', 'defective', 'damaged', 'wrong_item', 'not_as_described', 'late', 'other')),
  reason_text text,
  photos text[] not null default '{}',                 -- return-photos deposu yolları
  customer_name text, customer_phone text, customer_email text,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'label_ready', 'in_transit', 'received', 'refunded', 'closed', 'cancelled')),
  decision text check (decision in ('auto', 'seller', 'marketplace')),
  decision_note text,
  ai jsonb,                                            -- { category, defect_likely, summary, confidence }
  amount numeric,                                      -- iade edilecek tutar
  currency text not null default 'TRY',
  shipping_payer text check (shipping_payer in ('seller', 'customer')),
  return_code text,                                    -- kargo iade kodu / barkod
  tracking_number text,
  carrier text,
  restocked boolean not null default false,
  supplier_claim jsonb,                                -- CJ dispute { status, disputeId, requested_at, result }
  refund_status text not null default 'none' check (refund_status in ('none', 'pending', 'done', 'marketplace')),
  refunded_at timestamptz,
  received_at timestamptz,
  events jsonb not null default '[]'::jsonb,           -- [{ at, status, note }]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, external_id)
);
create index if not exists returns_user_idx on public.returns (user_id, created_at desc);
create index if not exists returns_status_idx on public.returns (status);
alter table public.returns enable row level security;
drop policy if exists own_returns_select on public.returns;
create policy own_returns_select on public.returns for select to authenticated using (user_id = auth.uid());

-- Satıcının iade kuralları (bir kez girilir)
create table if not exists public.return_rules (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auto_approve boolean not null default true,
  max_auto_amount numeric not null default 1000,         -- bu tutarın üstü satıcı onayına
  window_days int not null default 14,                   -- teslimden sonra kaç gün (TR / AB: 14 gün cayma)
  auto_reasons text[] not null default '{size,changed_mind,wrong_item,not_as_described,late}',
  photo_reasons text[] not null default '{defective,damaged}',   -- fotoğraf istenir; AI kusur görürse otomatik onay
  restock boolean not null default true,                 -- teslim alınınca stoğa geri ekle
  customer_pays_reasons text[] not null default '{size,changed_mind}',  -- kargo ücretini müşteri öder
  supplier_claim boolean not null default true,          -- kusurlu dropshipping ürününde CJ'ye otomatik anlaşmazlık
  updated_at timestamptz not null default now()
);
alter table public.return_rules enable row level security;
drop policy if exists own_return_rules on public.return_rules;
create policy own_return_rules on public.return_rules for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Para iadesi defteri
create table if not exists public.refund_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  return_id uuid references public.returns(id) on delete set null,
  amount numeric not null,
  currency text not null default 'TRY',
  method text not null,                                  -- marketplace | payment_provider | manual (havale / kapıda ödeme)
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  note text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
alter table public.refund_ledger enable row level security;
drop policy if exists own_refunds_select on public.refund_ledger;
create policy own_refunds_select on public.refund_ledger for select to authenticated using (user_id = auth.uid());

-- Gönderiler: iade gönderisi (müşteriden satıcıya)
alter table public.shipments add column if not exists kind text not null default 'outbound';
alter table public.shipments add column if not exists return_id uuid references public.returns(id) on delete set null;
create unique index if not exists shipments_one_per_return on public.shipments (return_id) where return_id is not null and status <> 'cancelled';

-- İade fotoğrafları: özel depo (satıcı kendi klasörünü okur)
insert into storage.buckets (id, name, public) values ('return-photos', 'return-photos', false) on conflict (id) do nothing;
drop policy if exists own_return_photos_read on storage.objects;
create policy own_return_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'return-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Asistan: satıcı kararı gereken iade
create or replace function public.assistant_on_return()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.status = 'requested') or (tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('received')) then
    perform public.assistant_enqueue(new.user_id, 'return',
      jsonb_build_object('return_id', new.id, 'status', new.status, 'reason', new.reason_code, 'text', coalesce(new.ai->>'summary', new.reason_text), 'amount', new.amount, 'currency', new.currency, 'source', new.source),
      'return:' || new.id::text || ':' || new.status);
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists trg_assistant_return on public.returns;
create trigger trg_assistant_return after insert or update of status on public.returns for each row execute function public.assistant_on_return();
