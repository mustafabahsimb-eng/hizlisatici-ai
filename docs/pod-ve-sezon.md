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

## 16 Ekim 2026 kararları (Mustafa)
- **Fiyat (aynı akşam değişti, aşağıya bak):** her satıştan net en az 10 $; Offsite Ads kapalı (hesaba katılmaz). net = fiyat − fiyat × %9,5 − 0,45 $ − Printify ürün − ABD kargo; ,99 ile biter. Mağaza TL: `to_try` ile ,99 TL. Uygulama: `printify_yukle.py guncelle` (yayındaki ilanlarda yalnız fiyat + açıklama Etsy'ye gider).
- **Üretici:** SwiftPOD (Gildan 18000).
- **Kargo:** sweatshirt'ler yalnız ABD'ye, ücretsiz ("Sweatshirts - US only - Free shipping", etsy-listings `us_shipping_profile`). Printify'ın kendi profili kurla düzeltildi (`shipping_profile_fx`): Printify tutarları mağaza para birimine çevirmeden yazar.
- **İade:** fikir değiştirme iadesi / değişim yok (Etsy iade politikası `return_policy`); kusur, hasar, yanlış ürün fotoğrafla bildirilirse ücretsiz yeniden gönderim; isimli ürün iade edilmez. Metin ilan açıklamasında ve satış sonrası mesajda. Etsy, ek mağaza politikası metnini (policy_additional) bu mağazada kabul etmiyor ("EU Terms").
- **Sorun bildirimi → Printify yeniden gönderim:** satış sonrası mesajdaki bağlantı `order-help.html?shop=<Etsy mağaza no>` → `pod-reprint` (Etsy siparişi + e-posta / posta kodu doğrulanır, fotoğraflar depoya, Printify `support-requests/reprint`, Telegram bildirimi; açılamazsa cron `pod-reprint-30m` 6 kez dener). Tablo `pod_reprints`, paket anahtarı `pod_reprint`.
- **Etsy kişiselleştirme:** yeni uç nokta `updateListingPersonalization` (eski is_personalizable alanları işlemiyor); soru başlığı "Personalization (kids' names)", siparişte `variations.formatted_name`.
- **Rakip fiyatları:** etsy-listings `market_prices` (resmi arama, USD ortanca).

## 16 Ekim 2026 akşam: toplu düzenleme (Mustafa)
- **Kural: Etsy'de yeni ilan / kopya / sil-yükle YOK** (her ilan ücretli). Printify ürünü güncellenir, mevcut Etsy ilanına yayınlanır; `printify_yukle.py guncelle` yayın bitince ilan numarasını karşılaştırır, değiştiyse DURUR.
  `guncelle [--metin] [--tasarim] [--yayinlama-yok] --only kod,...`: fiyat + açıklama (her zaman), başlık + etiket (`--metin`), baskı dosyası (`--tasarim`). Görsel ve kargo profiline dokunmaz.
- **Fiyat (önceki "net ≥ 10 $" kuralının yerine):** TL bant fiyatı `pricing.PRICE_TRY`: S–XL 1.749,99 · 2XL 1.899,99 · 3XL 1.949,99 TL. Koşul: temkinli %17 Etsy kesintisiyle de zarar yok (`price_try` aksi hâlde hata verir).
- **"Most Likely To" tasarımı:** yazı bloğu baskı alanının %93'ü (göğsün ~%60'ı; Printify baskı alanı daha genişine izin vermiyor). Koyu giysilerde (Black, Forest Green) krem yazı + kırmızı gölge + altın başlık; holly aynı. 4500×5400, 300 DPI şeffaf PNG (`designs.py`).
- **Başlık / etiket:** ilk 40 karakter "Most Likely To Christmas Sweatshirt", başlıkta "Matching Family Christmas Sweatshirt", ≤140; 13 etiket, tekrar yok (`collection.py`).
- **Grup görseli:** "Matching Family Christmas Sweatshirts" kolajı (4 ürün, 4 renk; `gorseller.group_image`) serideki her ilanda 2. görsel (seride 5 görsel).
- **Noel teslim satırı:** "Order by December 10 for delivery before Christmas (US)." açıklamanın en üstünde (season-calendar → etsy-listings `holiday_notice`; mağaza duyurusunda da). Tarih `app_cache printify_holiday_deadline:2026` = satıcı tarihi (`source: satici`); Printify resmi tarih açıklarsa onunki geçer. `guncelle` satırı Printify açıklamasının başına da koyar (yayın ezmesin).
- **Mama kişiselleştirme talimatı:** "Please enter the names (max 4), separated by commas."
- **Dijital "Set of 4 Stoic Quote Prints" (5 renk):** 599 → 379 TL (etsy-listings `listing_price`, ilan numarası aynı). Seltigo'da `products.sale_price` 379; `listings.price` 599 kaldı (değişirse Etsy'ye yeniden gönderim tetiklenir).

## Giyim ilanı görsel düzeni (16 Ekim 2026; tüm sweatshirt / tişört ilanlarında varsayılan)
`tools/pod-noel/gorseller.py` — `printify_yukle.py yayinla` yayından hemen sonra kendiliğinden uygular (`varsayilan`):
1. **Kapak:** renkli giysi (sand / light pink / forest green; tasarımla kontrast) gerçek kış / Noel üstten çekim sahnesinde (Pexels, ticari kullanım serbest; `scenes.py` ortası boş sahneleri bulur). Printify API yalnız düz ön mockup verdiği için sahne kompozisyonu burada: giysi Printify mockup'ından ayrılır (beyaz giysi için Sand maskesi), yumuşak gölge, renk kaydırma YOK. Her ilan ayrı sahne (`kapak_sahneleri.json`).
2. Düz ürün fotoğrafı (Printify ön görünüm, kapak rengi) · 3. Renk seçenekleri (5 renk) · 4. Beden tablosu (Printify size guide, inç + cm).
- Etsy'de görseller `etsy-listings set_images` ile değişir (önce yükle, sonra eskileri sil). Printify sonraki güncellemelerde `images: false` ile yayınlar, görseller ezilmez.
- Açıklama sonu: "Original design by bahsistore, created with generative design tools." (`collection.py` şablonu).
- Kargo "Sweatshirts - US only - Free shipping" ve iade politikası da yayında atanır.

## Etsy senkronu (`etsy-sync`)
- Bağlı her Etsy mağazasındaki tüm ilanlar Seltigo ürün listesine: saatlik (cron `etsy-sync-1h`), Etsy bağlanınca hemen (`etsy-token-exchange`), Printify bağlanınca webhook kaydı + ilk senkron (`printify-connect`), Printify'da ürün yayınlanınca / değişince / silinince webhook (`?t=PRINTIFY_WEBHOOK_TOKEN`, 90 sn sonra). Etsy'nin ilan değişikliği webhook'u yok (yalnız sipariş olayları) -> Etsy panelinden eklenenler saatlik gelir.
- Eşleştirme `listings.external_listing_id`; dışarıda yönetilen ilan `attributes.managed_by` = printify | etsy -> gönderim kuyruğuna girmez (migration 20261019_etsy_sync). Etsy'de olmayan ilan `validation.etsy.state = removed` (panelde "Etsy'de yok").
- Printify ürünü: maliyet = ilan fiyatındaki varyantın Printify maliyeti + ABD ilk ürün kargosu, mağaza para birimine çevrilir (`supplier_price`); Etsy kesintileri `commission_rate` 9,5 + `fixed_fee` 0,45 $. Panel (dashboard / report) `fixed_fee`'yi net kârdan düşer; "Printify" etiketi.
- Test: `tests/e2e/etsy_senkron.py` (7/7).
