# Baskılı ürün (Printify → Etsy), isimli sipariş otomasyonu ve sezon takvimi

## Noel koleksiyonu (tools/pod-noel)
- `designs.py`: 15 tasarım (8 "Most Likely To", gingerbread, pembe Noel, isimli patchwork Mama, 3 bereli hayvan, kitapsever). Şeffaf PNG 4500×5400, 300 dpi; her biri iki mürekkep: `dark` (Sand / White / Light Pink) ve `light` (Black / Forest Green). Yazı tipleri OFL / Apache (Google Fonts). Çıktı `%LOCALAPPDATA%\seltigo-pod\designs` (satılık; depoya girmez).
- `collection.py` → `collection.json`: İngilizce başlık (≤140), 13 etiket, açıklama, sezon, kişiselleştirme ayarı, giysi karşılaştırması.
- `pricing.py`: fiyat ≥ (maliyet + 0,45 $) ÷ (1 − 0,065 − 0,03 − 0,15 − 0,35); .99'a yuvarlanır. Offsite Ads her zaman hesaba katılır.
- `printify_yukle.py hazirla` → Printify'da taslak ürünler + gerçek maliyetle fiyat + mockup raporu; `yayinla` → Etsy'ye yayın, Mama ilanında Etsy kişiselleştirme kutusu, `pod_products` ve `season_listings` kayıtları.
- Test: `tests/pod/printify_yukle_test.py` (sahte Printify), `tests/pod/pod_personalize_test.ts` (isim ayrıştırma + gerçek çizim).

## İsimli sipariş (supabase/functions/pod-personalize, 5 dk)
Printify'ın Etsy kişiselleştirme alanları yalnız Printify arayüzünde kurulabiliyor (Public API'de alan oluşturma yok; yalnız API siparişine kişiselleştirme eklenebiliyor). Bu yüzden akış tamamen API ile:
1. Printify'da bekleyen siparişler okunur (mağaza ayarı: siparişler elle onay).
2. `metadata.shop_order_id` = Etsy siparişi → alıcının yazdığı isimler (getShopReceipt, transaction variations "Personalization").
3. İsim katmanı resvg-wasm + Pacifico ile çizilir, depoya konur. Yerleşim `tools/pod-noel/mama_layout.json` + baskı alanı oranı (`pod_products.personalization`).
4. İsimsiz sipariş önce iptal edilir (iki kez basılmasın), aynı adrese taban + isim katmanlı yeni sipariş açılır, üretime gönderilir.
5. Kargo çıkınca takip numarası Etsy siparişine işlenir. Her adım asistan kanalına (Telegram) "notice" olarak gider.
Kişiselleştirilmemiş ve tümü Seltigo POD ürünü olan bekleyen siparişler üretime gönderilir. Paket anahtarı `pod_personalize`.

## Sezon takvimi (supabase/functions/season-calendar, günde 1)
- `seasons`: tarih kuralı (`fixed:MM-DD`, `easter`, `nth:AY:GÜN:N`) + yayına çıkış / bitiş farkı; her yıl kendiliğinden hesaplanır (Paskalya, Anneler / Babalar Günü, Şükran Günü dahil). Test: `tests/season/season_rules_test.ts` (Mustafa'nın 2026-27 tarihleri birebir).
- `season_listings`: ilan ↔ sezon. Sezon başlayınca `etsy-listings listing_state active`, bitince `inactive` (SİLİNMEZ; yorum ve satış geçmişi kalır).
- Sezondan 14 gün önce Etsy resmi aramasıyla (findAllListingsActive) tohum kelimeler kontrol edilir; sonuç `season_trend_checks`, yeni etiketler `seasons.trend_tags`.
- Her yıl açık: kitapsever, stoacı sözler, bereli hayvanlar, isimli Mama / Grandma (evergreen; dokunulmaz). Paket anahtarı `season_calendar`.

## Etsy mağaza düzeni (etsy-listings)
- `organize`: bölümleri oluşturur (yoksa, verilen sırayla), ilanları yerleştirir, öne çıkanları sıralar (`featured_rank`).
- `listing_state`: yayına al / pasife al. `listing_personalization`: kişiselleştirme kutusu.
- bahsistore için: `tools/etsy-mockup/kapak_uygula.py` (25 kapak) ve `organize.py` (bölümler + 5 set öne çıkan).
