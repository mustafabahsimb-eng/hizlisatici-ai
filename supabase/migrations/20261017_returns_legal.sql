-- =========================================================
-- İade: yasal çerçeve katmanı (ülkeye göre; satıcı yasal minimumun altına inemez, yalnız lehine değiştirebilir)
-- TR: Mesafeli Sözleşmeler Yönetmeliği (1.1.2026 değişikliği dahil) — cayma 14 gün gerekçesiz; iade kargosu müşteriden alınamaz;
--     para iadesi ürün iade kargosuna verildikten sonra en geç 14 gün (ilk gönderim kargo ücreti dahil); ayıplı mal masrafı satıcıda.
-- AB / İngiltere: cayma 14 gün; para iadesi talepten 14 gün (ürün dönene kadar bekletilebilir); iade kargosunu müşteri ancak
--     ön bilgilendirmede açıkça yazılmışsa öder.
-- ABD ve diğer: yasal cayma yok; mağaza iade politikası geçerli (politika metni otomatik üretilip yayınlanır).
-- =========================================================
create table if not exists public.return_laws (
  region text primary key,                       -- TR | EU | GB | US | OTHER
  statutory boolean not null,                    -- yasal cayma hakkı var mı
  window_days int not null,                      -- yasal cayma süresi (statutory değilse varsayılan politika süresi)
  refund_days int not null,                      -- para iadesi süresi
  refund_clock text not null check (refund_clock in ('handed_to_carrier', 'request', 'approval')),
  customer_may_pay boolean not null,             -- iade kargosunu müşteri ödeyebilir mi
  disclosure_required boolean not null,          -- müşteri öderse ön bilgilendirmede yazılı olmalı
  defect_days int not null,                      -- ayıplı mal bildirimi süresi
  refund_original_shipping boolean not null,     -- caymada ilk gönderim kargo ücreti de iade edilir
  law_name_tr text not null, law_name_en text not null,
  updated_at timestamptz not null default now()
);
alter table public.return_laws enable row level security;
drop policy if exists return_laws_read on public.return_laws;
create policy return_laws_read on public.return_laws for select using (true);
insert into public.return_laws (region, statutory, window_days, refund_days, refund_clock, customer_may_pay, disclosure_required, defect_days, refund_original_shipping, law_name_tr, law_name_en) values
  ('TR', true, 14, 14, 'handed_to_carrier', false, false, 730, true, 'Mesafeli Sözleşmeler Yönetmeliği', 'Turkish Distance Contracts Regulation'),
  ('EU', true, 14, 14, 'request', true, true, 730, true, 'AB Tüketici Hakları Direktifi', 'EU Consumer Rights Directive'),
  ('GB', true, 14, 14, 'request', true, true, 730, true, 'Birleşik Krallık Tüketici Sözleşmeleri Yönetmeliği', 'UK Consumer Contracts Regulations'),
  ('US', false, 30, 14, 'approval', true, true, 365, false, 'Mağaza iade politikası', 'Store return policy'),
  ('OTHER', false, 14, 14, 'approval', true, true, 365, false, 'Mağaza iade politikası', 'Store return policy')
on conflict (region) do update set statutory = excluded.statutory, window_days = excluded.window_days, refund_days = excluded.refund_days, refund_clock = excluded.refund_clock,
  customer_may_pay = excluded.customer_may_pay, disclosure_required = excluded.disclosure_required, defect_days = excluded.defect_days,
  refund_original_shipping = excluded.refund_original_shipping, law_name_tr = excluded.law_name_tr, law_name_en = excluded.law_name_en, updated_at = now();

-- Ülke kodu -> bölge (global katman: countries.eu_member)
create or replace function public.return_law_region(p_country text) returns text language sql stable set search_path = public as $$
  select case
    when upper(coalesce(p_country, '')) = 'TR' then 'TR'
    when upper(coalesce(p_country, '')) in ('GB', 'UK') then 'GB'
    when upper(coalesce(p_country, '')) = 'US' then 'US'
    when exists (select 1 from public.countries c where c.code = upper(p_country) and c.eu_member) then 'EU'
    else 'OTHER' end
$$;

-- Satıcı kuralları: lehine değişiklikler
alter table public.return_rules add column if not exists customer_pays boolean not null default false;      -- yalnız yasanın izin verdiği yerde (TR'de kilitli: kapalı)
alter table public.return_rules add column if not exists refund_warn_days int not null default 3;            -- para iadesi son gününe kaç gün kala uyar
alter table public.return_rules add column if not exists policy_days int not null default 30;               -- ABD / diğer: mağaza iade süresi

-- İade kaydı: hangi hukuk, cayma mı, para iadesi son günü, şüphe işaretleri, adresten alım
alter table public.returns add column if not exists law text;
alter table public.returns add column if not exists withdrawal boolean not null default false;
alter table public.returns add column if not exists refund_due_at timestamptz;
alter table public.returns add column if not exists refund_warned_at timestamptz;
alter table public.returns add column if not exists fraud jsonb;
alter table public.returns add column if not exists pickup boolean not null default false;

-- Ürün: cayma hakkı istisnası (kişiye özel, dijital, hijyen ambalajı açılmış, çabuk bozulan, fiyatı piyasaya bağlı, açılmış kitap / yazılım)
alter table public.products add column if not exists withdrawal_exempt boolean not null default false;
alter table public.products add column if not exists withdrawal_exempt_reason text
  check (withdrawal_exempt_reason is null or withdrawal_exempt_reason in ('personalized', 'digital', 'hygiene', 'perishable', 'market_price', 'sealed_media'));
alter table public.products add column if not exists withdrawal_exempt_manual boolean not null default false;   -- satıcı elle değiştirdiyse otomatik işaret dokunmaz

-- Otomatik işaret: dijital ürünler ve Printify kişiselleştirilmiş ürünler
create or replace function public.products_withdrawal_exempt_auto() returns trigger language plpgsql set search_path = public as $$
begin
  if new.withdrawal_exempt_manual then return new; end if;
  if new.product_type = 'digital' then
    new.withdrawal_exempt := true; new.withdrawal_exempt_reason := 'digital';
  elsif new.supplier = 'printify' and (coalesce(new.specs::text, '') ~* '"personali[sz]' or concat_ws(' ', new.name, new.generated_title) ~* '(kişiye özel|kisiye ozel|isme özel|isimli|personali[sz]ed|custom name)') then
    new.withdrawal_exempt := true; new.withdrawal_exempt_reason := 'personalized';
  elsif new.withdrawal_exempt_reason in ('digital', 'personalized') then
    new.withdrawal_exempt := false; new.withdrawal_exempt_reason := null;   -- koşul kalktı (ör. fiziksel ürüne çevrildi)
  end if;
  return new;
end $$;
drop trigger if exists trg_products_withdrawal_exempt on public.products;
create trigger trg_products_withdrawal_exempt before insert or update of product_type, supplier, name, generated_title, specs, withdrawal_exempt_manual on public.products
  for each row execute function public.products_withdrawal_exempt_auto();
update public.products set withdrawal_exempt = true, withdrawal_exempt_reason = 'digital' where product_type = 'digital' and not withdrawal_exempt_manual and not withdrawal_exempt;
update public.products set withdrawal_exempt = true, withdrawal_exempt_reason = 'personalized' where supplier = 'printify' and not withdrawal_exempt_manual and not withdrawal_exempt
  and (coalesce(specs::text, '') ~* '"personali[sz]' or concat_ws(' ', name, generated_title) ~* '(kişiye özel|kisiye ozel|isme özel|isimli|personali[sz]ed|custom name)');

-- Her siparişe iade taşıyıcısı ve iade kodu (ön bilgilendirmede ve takip sayfasında görünür)
alter table public.store_orders add column if not exists return_carrier text;
alter table public.store_orders add column if not exists return_code text;
create or replace function public.store_orders_return_info() returns trigger language plpgsql security definer set search_path = public as $$
declare v_provider text;
begin
  if new.return_code is null then new.return_code := 'IADE-' || upper(substr(replace(new.id::text, '-', ''), 1, 8)); end if;
  if new.return_carrier is null then
    select provider into v_provider from public.shipping_accounts where user_id = new.user_id and is_default and status in ('connected', 'verify_pending') limit 1;
    new.return_carrier := case v_provider when 'yurtici' then 'Yurtiçi Kargo' when 'aras' then 'Aras Kargo' when 'mng' then 'MNG Kargo' when 'ptt' then 'PTT Kargo'
      when 'surat' then 'Sürat Kargo' when 'geliver' then 'Geliver' when 'hepsijet' then 'HepsiJet' when 'sendeo' then 'Sendeo' else v_provider end;
  end if;
  return new;
end $$;
drop trigger if exists trg_store_orders_return_info on public.store_orders;
create trigger trg_store_orders_return_info before insert on public.store_orders for each row execute function public.store_orders_return_info();
update public.store_orders set return_code = 'IADE-' || upper(substr(replace(id::text, '-', ''), 1, 8)) where return_code is null;

-- Satıcının yasal çerçevesi (panel için): ana ülke -> bölge + kurallar
create or replace function public.my_return_law() returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(l) || jsonb_build_object('country', s.c)
  from (select coalesce((select home_country from public.user_profiles where user_id = auth.uid()), 'TR') as c) s
  join public.return_laws l on l.region = public.return_law_region(s.c)
$$;
grant execute on function public.my_return_law() to authenticated;
