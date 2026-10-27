# PDF + link ile ürün yükleme (WhatsApp / Telegram / panel)

Satıcı toptancı PDF'ini (resimli katalog ya da resimsiz fiyat listesi) ve/veya bir mağaza linkini gönderir; ürünler okunur,
eşleştirilir, taslak olarak kaydedilir, satıcıya özet + [Yayınla] / [Panelde kontrol et] gider. Panelde aynı motor:
Toplu Yükleme > 📥 PDF + link (geçici ad).

## Parçalar
| Parça | Ne yapar |
|---|---|
| `supabase/functions/_shared/pdf-catalog.ts` | ÜCRETSİZ PDF okuyucu (pdf.js / unpdf 1.8.1): yazı katmanı + gömülü görseller konumlarıyla. Tablo (başlık satırı, iki satıra bölünen hücreler), kart (resimli katalog; görsel merkezli gruplama), satır düzeni. Barkod (EAN doğrulamalı), model kodu, stok, bayi / PSF, renk / beden varyantları. Görsel ↔ ürün konuma göre. Okuyamadığı sayfaları `needAi` diye bildirir. |
| `supabase/functions/catalog-import` | Motor. Başlat, kuyruğa böl, PDF parçası, link keşfi / sayfaları, birleştir, kaydet, yayınla, bildir. |
| `sync_jobs` (`job_type = 'catalog_import'`) | Parçalar kuyrukta; `sync-worker` her işi `catalog-import`'a devreder (her parça kendi isteğinde, Edge Function süre sınırına takılmaz). Kuyruğa eklenince işçi hemen uyandırılır. |
| `product-import` | Link okuyucu: Shopify / WooCommerce API'si, XML, ikas ve Ticimax tanıma (Ticimax `productDetailModel`), site haritası, JSON-LD / OpenGraph, gerekirse yapay zekâ. |
| `product-ingest` | Kayıt. `dedupe: true` → barkod > aynı kaynak linki > SKU / model kodu eşleşirse yeni ürün açılmaz; maliyet, satış, stok (ve eksikse görsel / açıklama) güncellenir. |
| `_shared/assistant-core.ts` | WhatsApp / Telegram: PDF ve mağaza linki motora gider; 10 dk içinde gelen ikinci kaynak aynı yüklemeye eklenir; düğmeler `cimp_pub`, `cimp_panel`, `cimp_m`. |
| `whatsapp-webhook` | Meta Cloud API: GET doğrulama, POST'ta `X-Hub-Signature-256` (anahtar yoksa hiçbir istek kabul edilmez, sabit süreli karşılaştırma). |
| Tablolar | `catalog_imports` (geçmiş), `catalog_import_rows` (satırlar, eksikler, hatalar), `rate_limits` + `rate_hit()`, `ai_quotas` + `ai_quota_ok()`, `ai_usage_log` (birim + jeton). Depo `catalog-uploads` (özel, yalnız PDF, 20 MB). Paket anahtarı `pdf_link_import`. Migration `20261027_catalog_import.sql`. |

## Akış
1. Kaynak: PDF (≤ 20 MB, ≤ 100 sayfa, `%PDF-` imzası) ve/veya link. Aynı mesajda ikisi → tek yükleme. Ayrı mesajlarda 10 dk içinde eksik olan kaynak → aynı yüklemeye eklenir.
2. PDF 6'şar sayfalık parçalar halinde paralel okunur. Önce ücretsiz okuyucu; yalnız okunamayan sayfalar (taranmış, karmaşık) yapay zekâya gider (kota: `ai_quota_ok`, her çağrı `ai_usage_log`'a).
3. Link: Shopify / Woo beslemesi doğrudan; site haritası varsa PDF ürünlerine benzeyen linkler (ürün başına en iyi 2) 8'erli parçalarla okunur. PDF yoksa tüm ürünler (≤ 1000).
4. Birleştirme: barkod > SKU / model kodu > ad benzerliği (≥ 0,55). Fiyat + stok PDF'ten, görsel + açıklama + seçenekler linkten. PDF esastır; eşleşmeyen site ürünleri eklenmez.
5. Fiyat: PDF fiyatı toptan / bayi ise maliyet; satış = Ayarlar > Kâr kuralı. Kural yoksa asistan bir kez sorar ([%30] [%50] [%100] ya da "%40"), `import_rules`'a yazar.
6. Kayıt 10'arlı paralel parçalarla, TASLAK. Görseli olmayanlar için görsel tamamlama işi açılır (marka sitesi → toptancı sitesi → CJ / AliExpress).
7. Özet: "X ürün bulundu (a yeni, b güncellendi), Y'sinde eksik bilgi var" + [Yayınla] [Panelde kontrol et]. "%45" yazılırsa fiyatlar yeniden hesaplanır.
8. [Yayınla]: Kendi Mağazam + Varsayılan kanallar (bağlı olanlar). Fiyatsız ürün yayınlanmaz, satıcıya söylenir.

## Sınırlar
- Belge: yalnız PDF (diğer belgeler kibarca reddedilir; ürün fotoğrafı ayrı akış). 20 MB / 100 sayfa.
- Numara başına: dakikada 20, günde 400 mesaj (aşılınca 10 dk'da bir uyarı). Bağlı olmayan numaraya kibar cevap 10 dk'da bir. Bağlama kodu denemesi saatte 10.
- Kullanıcı başına yükleme: saatte 30, günde 150.
- Yapay zekâ kotası: `ai_quotas` (scope `default` ya da kullanıcı kimliği, `monthly_units`); boşsa sınırsız. Paketler belirlenince doldurulur.

## Testler
- `tests/e2e/whatsapp_katalog_dosyalari.py` örnek PDF'ler (resimli katalog, resimsiz tablo, Shopify / Woo eşleşmeli listeler).
- `tests/e2e/whatsapp_katalog.py` uçtan uca (asistan test sohbeti + panel).
- `tests/e2e/whatsapp_webhook_imza.py` webhook'u yerelde bilinen test anahtarıyla çalıştırır, imzalı / imzasız / yanlış imzalı istekler, bağlama, sınırlar.

## Gerçek WhatsApp için kalan
Seltigo'nun WhatsApp numarası (Meta test numarası) secrets'a girilince (`ASSISTANT_WA_*`, YARIM_ISLER.md) ve Meta panelinde webhook
`https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/whatsapp-webhook` adresine "messages" alanıyla abone edilince çalışır.
Doğrulama anahtarı `WHATSAPP_VERIFY_TOKEN` secret'ında; imza anahtarı `FACEBOOK_CLIENT_SECRET` (Meta uygulamasının App Secret'ı).
