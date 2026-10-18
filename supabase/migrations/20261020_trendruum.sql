-- =========================================================
-- Trendruum pazaryeri (trendruum.com; satıcı paneli seller.trendruum.com)
-- Kod: _shared/trendruum.ts, trendruum-verify, sync-worker (trendruum_tr adaptörü), marketplace-orders (sipariş + takip).
-- Canlı API varsayılan KAPALI: Edge secret TRENDRUUM_ENABLED=true olmadan Trendruum'a istek gitmez (ilan prova, bağlantı "onay bekliyor").
-- Ayrıntı: docs/trendruum.md
-- =========================================================

insert into public.marketplaces
  (code, name, country_code, currency, language, default_commission_pct, commission_is_approximate, requires_ean, requires_gpsr,
   supports_variants, vat_collected_by_marketplace, max_title_length, max_images, price_rounding, test_mode, api_sandbox_url, api_live_url, is_active)
values
  ('trendruum_tr', 'Trendruum', 'TR', 'TRY', 'tr', null, true, false, false,
   true, false, 100, 8, 'x.99', 'unknown', null, null, true)
on conflict (code) do nothing;

-- Paket anahtarı (ücretli olabilecek özellik; varsayılan açık — canlı API ayrıca TRENDRUUM_ENABLED ile açılır)
insert into public.feature_flags (key, name_tr, enabled, note)
values ('trendruum', 'Trendruum bağlantısı (ilan, fiyat / stok, sipariş, kargo bildirimi)', true, 'Canlı API: Edge secret TRENDRUUM_ENABLED=true')
on conflict (key) do nothing;
