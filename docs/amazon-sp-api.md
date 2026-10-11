# Amazon SP-API (TR + Global) — kurulum ve durum

Kaynaklar (resmi): developer-docs.amazon/sp-api — uç noktalar, pazar kimlikleri, Seller Central adresleri, "website authorization workflow", sandbox; modeller: github.com/amzn/selling-partner-api-models.

## Ne hazır (13 Ekim 2026)
- **Bağlantı:** Hesaplarım → Amazon TR / Amazon (Avrupa · Kuzey Amerika · Uzak Doğu) → [Mağazanı Bağla] → Amazon Seller Central onay sayfası → `amazon-callback.html` → `amazon-connect` (kod 5 dk içinde değiştirilir, `state` 10 dk tek kullanımlık). Satıcının bölgesindeki tüm Amazon ülkeleri (getMarketplaceParticipations) ayrı `store_connections` satırı olur; yenileme anahtarı Vault'ta.
- **İlan (sync-worker, tüm `amazon_*` pazarları):** `_shared/amazon-listing.ts`
  - Barkod geçerli ve katalogda ASIN varsa yalnız teklif (LISTING_OFFER_ONLY) — en hızlı yol.
  - Yoksa ürün türü (önce satıcının benzer ürünü, sonra Amazon araması) → şema (önbellek `amazon_product_types`, 14 gün) → zorunlu nitelikleri AI doldurur → tam ilan. Barkod yoksa GTIN muafiyeti beyanı + uyarı.
  - Seçenekli ürün: ana + alt SKU (variation_theme şemadan), seçenekler paralel gönderilir.
  - Prova (bağlantıda `dry_run`, sandbox'ta varsayılan): `mode=VALIDATION_PREVIEW`, hiçbir şey yayınlanmaz, Amazon'un hataları ilana yazılır.
  - İçerik değişmediyse fiyat/stok yalnız PATCH (AI ve şema yok). Satıştan kaldırma = stok 0.
  - SKU: `SLT-<ürün no>[-<seçenek sırası>]`.
- **Sipariş (amazon-orders, 15 dk):** son güncellenen MFN siparişleri → `marketplace_orders` (kişisel veri 30 gün sonra silinir); AliExpress/CJ ürünü ise tetikleyici tedarikçi siparişi açar (adres gelmediyse `onay_bekliyor / adres_yok`); asistana "Yeni sipariş (Amazon XX)" bildirimi; tedarikçi takip numarası gelince Amazon'a gönderildi bildirimi (confirmShipment); kabul edilen ilanın ASIN'i ve Amazon uyarıları ilana yazılır. Satıcı yetkiyi geri alırsa bağlantı "süresi doldu" + asistan uyarısı.
- **Barkodsuz ürün:** marka + model koduyla Amazon kataloğunda aranır; model tutarsa (ya da AI "aynı ürün" derse) yalnız teklif açılır ve katalogdaki barkod ürüne yazılır.
- **Etiket:** Amazon siparişinde kendi stoğundaki ürün için satıcının varsayılan kargo hesabıyla gönderi + etiket (shipping-hub); hesap yoksa ABD, Kanada, İngiltere, Almanya, Fransa, İtalya, İspanya, Japonya, Avustralya'da Amazon "Buy Shipping" (en ucuz hizmet; ücret satıcının Amazon hesabından; bağlantı ayarı buy_shipping=false ile kapanır). Etiketler asistanın "bugün gönderilecekler" PDF'ine eklenir.
- **Hız:** ilan kuyruğuna iş düşünce sync-worker beklemeden çalışır (tetikleyici sync_jobs_kick, en fazla 5 sn'de bir).
- **Testler:** `tests/amazon/amazon_sandbox_test.ts` (Amazon'un kendi statik sandbox örnekleriyle, 13/13), `tests/amazon/amazon_db_test.sql` (tetikleyiciler, geri alınır, 7/7), `tests/e2e/amazon_baglanti.py` (Hesaplarım + geri dönüş sayfası). Gerçek sandbox: `amazon-connect` `{action:"selftest"}` (sistem çağrısı).

## Açmak için gerekenler (Mustafa) — KARAR: şirket kurulunca (public developer); adımlar YOL-HARITASI.md "Amazon" bölümünde
Seltigo herkese açık bir uygulama olduğu için kalıcı yol **Solution Provider Portal "public developer"** kaydıdır (Appstore listesi + Amazon onayı; şirket bilgileri ve web sitesi istenir) → şirket kurulunca.
Şimdi sandbox'ta uçtan uca denemek için en kısa yol:
1. Amazon TR **Profesyonel** satıcı hesabı (bireysel hesap geliştirici olamaz; Profesyonel plan ücretlidir).
2. Seller Central → Uygulamalar ve Hizmetler → Uygulama Geliştir → geliştirici kaydı (birincil kullanıcı olarak).
3. Uygulama oluştur (taslak): roller "Ürün Listeleme", "Envanter ve Sipariş Takibi"; OAuth yönlendirme adresi: `https://mustafabahsimb-eng.github.io/hizlisatici-ai/amazon-callback.html`.
4. Uygulamayı kendi hesabına yetkilendir ("Authorize app") → yenileme anahtarı.
5. Supabase secrets: `AMAZON_APP_ID`, `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_SANDBOX_REFRESH_TOKEN`. (`AMAZON_LIVE` yoksa her şey sandbox'ta; `AMAZON_APP_DRAFT=false` yayın onayından sonra.)
Bunlar girilince: selftest + Hesaplarım'dan bağlanma testi Claude tarafından yapılır.

## Kişisel veri (alıcı adı / adres)
Adres için uygulamada kısıtlı rol (PII) + Amazon güvenlik incelemesi gerekir. Rol yoksa sipariş adresiz gelir ve tedarikçi siparişi onaya düşer (asistan uyarır).
