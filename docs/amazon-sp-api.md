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
- **Testler (13 Ekim):** `tests/amazon/amazon_sandbox_test.ts` (Amazon'un kendi statik sandbox örnekleriyle), `tests/amazon/amazon_db_test.sql` (tetikleyiciler, geri alınır, 7/7), `tests/e2e/amazon_baglanti.py` (Hesaplarım + geri dönüş sayfası). Gerçek sandbox: `amazon-connect` `{action:"selftest"}` (sistem çağrısı).

## Hızlı yükleme katmanı (19 Ekim 2026)
- **Pazar dilinde metin** (`_shared/amazon-content.ts`): her Amazon pazarı için kendi dilinde başlık, 5 madde, açıklama, arama terimleri (AI; önbellek `validation.amazon.content`).
  Kurallar otomatik düzeltilir:
  - başlık: pazar sınırı (200), `! $ ? _ { } ^ ¬ ¦` yok, kelime en fazla 2 kez, tamamı büyük harf kelime yok
  - tanıtım ifadeleri (12 dil) ve kanıt isteyen iddialar (antibakteriyel, çevre dostu, tedavi...) çıkarılır
  - maddeler en fazla 5 × 500 karakter; iletişim bilgisi / bağlantı / ASIN çıkarılır
  - arama terimleri 249 **bayt** sınırında, başlık / marka / tekrar kelimeleri olmadan
- **Ürün türü:** öğrenilmiş tür → Amazon araması → birden çok aday varsa AI ürün adı + **ana görselle** seçer.
- **Görsel** (`_shared/amazon-images.ts`, imagescript):
  - ana görsel ölçülür: kenar zemini beyaz mı, ürün kareyi dolduruyor mu, boyut
  - açık zemin saf beyaza çekilir; ürün beyaz kare tuvalde %90'a ortalanır (1000-2000 px)
  - zemin renkliyse kurala uyan diğer görsel ana görsel olur; hiçbiri uymazsa uyarı
  - ücretli zemin silme `AMAZON_AUTO_BG_REMOVE=true` ile açılır (remove.bg anahtarı `REMOVEBG_API_KEY` panelle ortak; varsayılan KAPALI)
  - düzeltilen görsel `product-images/amazon/...` altında
- **Barkod:**
  - barkodlu ürün katalogda varsa yalnız teklif
  - GS1 mağaza içi önekleri (02 / 04 / 2xx) Amazon'da geçmez → barkodsuz yol
  - barkodsuzda önce marka + modelle katalog eşleme, yoksa GTIN muafiyeti beyanı + uyarı
- **Kategori onayı (ungating):**
  - ASIN'li üründe teklif açmadan önce Listings Restrictions API sorulur; onay gerekiyorsa gönderilmez, Amazon'un onay bağlantısı ilana yazılır
  - yeni üründe onay isteyen ürün türleri listesi (`GATED_TYPES`) ve ABD tatil dönemi oyuncak kısıtı önceden uyarılır
- **Ret → düzelt → yeniden gönder:**
  - Amazon'un hata mesajı + nitelik adı okunur; nitelik hataları AI ile düzeltilip en fazla 2 kez otomatik yeniden gönderilir; görsel reddinde sıradaki görsel denenir
  - onay / barkod hatası düzeltilmeye çalışılmaz, satıcıya açıklanır
  - Amazon sonradan itiraz ederse `amazon-orders` ilanı günde en fazla bir kez kuyruğa geri koyar
- **Çok pazar:**
  - bağlı her Amazon pazarı ayrı ilan; her biri kendi dili, para birimi ve x,99 fiyatıyla (JPY / INR kuruşsuz; yuvarlama fiyatı asla düşürmez)
  - ilan kuyruğu (sync-worker) artık 6 ilanı aynı anda işler (önceden sırayla)
  - bir ilanın içinde görsel + metin hazırlığı ile ürün türü + şema + nitelik hazırlığı aynı anda yürür
- **Zarar kontrolü (kapatılamaz):** fiyat − Amazon komisyonu (varsayılan %15, `marketplaces.default_commission_pct`) − maliyet (pazar para birimine kurla) < 0 ise gönderilmez.
- **Siparişler: Orders API v2026-01-01** (v0 okuma uçları 27 Mart 2027'de kapanıyor)
  - satıcının tüm pazarları **tek istekte** (yeni kota satıcı başına çok düşük)
  - alıcı / adres siparişle gelir (ayrı kişisel veri anahtarı yok)
  - FBA siparişi atlanır; satıcının kendi girdiği takip numarası okunur
  - kargo bildirimi (confirmShipment) v0'da kalıyor
- **Süre** (gecikme benzetimi: Amazon isteği 300 ms, AI 2,5 sn; `tests/amazon/amazon_quality_test.ts`):

  | İş | Süre | Hedef |
  |---|---|---|
  | tam ilan (barkodsuz, AI'lı) | ~3,7 sn / pazar | < 15 sn |
  | ASIN'e teklif | ~0,9 sn | < 3 sn |
  | 6 pazar paralel | ~3,8 sn toplam | < 20 sn |
  | fiyat / stok güncelleme | ~0,3 sn | < 1,5 sn |

  Her ilanın adım süreleri `validation.amazon.timings` içinde.
- **Testler:**
  - `tests/amazon/amazon_sandbox_test.ts` 12/12 (Amazon örnekleri)
  - `tests/amazon/amazon_orders_test.ts` 5/5 (v2026 sipariş örnekleri: TR / UK / BR / JP)
  - `tests/amazon/amazon_quality_test.ts` 13/13
- **Gerçek Amazon sandbox'ı:** `python tools/amazon/amazon_ac.py test` → 6/6 geçti (19 Ekim; pazarlar, katalog, ilan provası, siparişler v2026, kategori onayı, etiket).

## Durum ve açmak için gerekenler
- Kayıtlı (6 Ekim): `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_SANDBOX_REFRESH_TOKEN` → sandbox çalışıyor.
- Eksik: `AMAZON_APP_ID` (uygulama numarası, `amzn1.sp.solution.` ile başlar). Yalnız satıcının Hesaplarım'dan "Amazon mağazanı bağla" onay sayfası için gerekir.
  Gelince: `python tools/amazon/amazon_ac.py uygulama-no <APP_ID>`.
- Uygulama ayarlarında iki adres: giriş adresi (Login URI) ve yönlendirme adresi (Redirect URI), ikisi de `https://mustafabahsimb-eng.github.io/hizlisatici-ai/amazon-callback.html`.
  Sayfa iki adımı da yapar: Amazon'un `amazon_callback_uri`'sine geri yollar, sonra kodu alır.
- Canlı: şirket kurulunca Solution Provider Portal "public developer" + Appstore onayı → `python tools/amazon/amazon_ac.py canli --yayinda`. Adımlar YOL-HARITASI.md "Amazon".

## Kişisel veri (alıcı adı / adres)
Adres için uygulamada kısıtlı rol (PII) + Amazon güvenlik incelemesi gerekir (Orders API v2026-01-01'de ayrı kişisel veri anahtarı / RDT gerekmez, rol yine gerekir). Rol yoksa sipariş adresiz gelir ve tedarikçi siparişi onaya düşer (asistan uyarır).
