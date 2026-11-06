# Sitemi Bağla + Tam Mağaza

## 1. Sitemi Bağla (site-baglanti.html)
Akış: adres → altyapı tespiti → sahiplik doğrulaması → aktarım (kuyrukta, ilerleme çubuğu) → sürekli eşitleme → bağlantı kodu.

| Parça | Yer |
|---|---|
| Tespit, doğrulama, aktarım, eşitleme, webhook gönderimi | `supabase/functions/site-connect` |
| Güvenlik (SSRF: tüm IP'ler herkese açık olmalı, yönlendirme başına denetim; robots.txt + Crawl-delay; aynı siteye ≥0,7 sn) | `_shared/site-guard.ts` |
| Resmi API okuyucuları (Shopify Admin, WooCommerce REST, Wix Stores) + CSV akış | `_shared/site-platforms.ts` |
| Bağlantı kodu REST API | `supabase/functions/site-api` |
| Yazılımcı kurulumu | `site-baglanti-kurulum.html`, `tools/site-baglanti/seltigo.php`, `seltigo.js` |

- **Okuma sırası:** resmi API (Hesaplarım'da aynı site bağlıysa) > ürün akışı (Google Merchant / XML / CSV; sayfadaki `<link rel=alternate>` ve bilinen yollar) > tarama (product-import: site haritası, JSON-LD, OpenGraph, mikroveri, yapay zekâ).
- **Doğrulama:** `<meta name="seltigo-site-verification" content="slt-…">`, DNS TXT `_seltigo.alanadi` = `seltigo-verification=slt-…`, ya da `seltigo-verification.txt` dosyası. Doğrulanmadan aktarım / API anahtarı yok.
- **Kuyruk:** `sync_jobs.job_type='site_connect'` → sync-worker devreder. Parçalar: discover, page (API sayfası), items (25 öğe), pages (8 sayfa, 12 sn aralıkla). Sayaçlar `site_run_bump` / `site_run_finish`.
- **Eşitleme:** `site-connect-tick` (10 dk) zamanı gelen bağlantılarda `sync`; değişmeyen ürün (özet) yeniden yazılmaz; sitede artık olmayan ürün stok 0 / tükendi.
- **Taşıma (`?mode=migrate`):** aynı aktarım + `store_redirects` (eski yol → `/p/<id>`), kendi alan adında Worker 301 verir.
- **Webhook:** `site_webhook_events` (ürün / stok tetikleyicisi, başka kanaldaki sipariş), `site-connect-webhooks` (1 dk), `X-Seltigo-Signature: sha256=HMAC(gövde)`, 6 deneme. Siteden gelen değişiklik geri yollanmaz (`seltigo.from_site`).
- **Ortak stok:** `marketplace_orders_stock` tetikleyicisi; vitrin siparişi, site siparişi (`marketplace_code='website'`) ve pazaryeri siparişi aynı yoldan düşer, iptal / iadede geri gelir; ürün stoğu değişince `products_enqueue_stock_sync` tüm ilanları eşitler.

## 2. Tam mağaza
| Parça | Yer |
|---|---|
| Vitrin katmanı (tema, SEO, ürün sayfası, sepet, hesap) | `magaza-pro.js` (magaza.html'den sonra) |
| Sepet / sipariş / ödeme dönüşleri / SEO GET | `store-checkout` (+ `_shared/store-cart.ts`, `payments.ts`, `store-seo.ts`) |
| Müşteri hesabı | `store-customer` (bcrypt, 30 gün oturum) |
| Satıcı ayarları, yapay zekâ tema, ödeme anahtarları, alan adı | `store-admin` (+ `_shared/store-theme.ts`), panel `magaza-yonetimi.html` |
| Kendi alan adı sunucusu | `tools/cloudflare/store-worker.js`, `wrangler.toml` |

- **Ödeme:** kapıda (isteğe bağlı ücret), havale (IBAN doğrulanır), iyzico Checkout Form (IYZWSv2), PayTR iFrame. Varsayılan sandbox; canlı için `store_payment_providers.environment='live'` + `PAYMENTS_LIVE=true`. Kartla ödemede sipariş, sağlayıcının sunucudan doğrulanan onayından sonra açılır.
- **Kendi alan adı:** `CF_API_TOKEN`, `CF_ZONE_ID`, `STORE_EDGE_HOST` yokken kayıt alınır, DNS kaydı gösterilir; açılınca `store-domain-tick` (10 dk) bekleyenleri Cloudflare for SaaS'a ekler, SSL aktif olunca `store_settings.custom_domain` yazılır. Domain Connect: `_domainconnect` TXT keşfi; şablon yayınlanınca `DOMAIN_CONNECT_PROVIDER_ID` / `DOMAIN_CONNECT_SERVICE_ID`.
- **Worker kurulumu (servis açılış günü):** `cd tools/cloudflare && npx wrangler deploy`; Cloudflare for SaaS fallback origin = Worker rotası; secrets'a üç değer.

## Paket anahtarları
`site_connect`, `site_api`, `store_checkout`, `store_payments`, `custom_domain`, `store_migrate`, `store_ai_design` (hepsi varsayılan açık).

## Testler
`tests/e2e/site_baglama.py` (36 kontrol), `tests/e2e/magaza_tam.py` (23 kontrol).
