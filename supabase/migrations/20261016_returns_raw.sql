-- İade: pazaryeri talebinin onay için gereken ham bilgileri (Trendyol claim / satır numaraları, n11 claimReturnId)
alter table public.returns add column if not exists raw jsonb;
