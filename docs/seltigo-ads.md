# Seltigo Ads (18 Ekim 2026) — A1 Meta katalog reklamı + A2 kural motoru

## Akış
1. **Bağlantı:** 📣 Reklamlar sayfasında "Facebook'u reklam izniyle bağla" düğmesine basılır. Mevcut izinlere `ads_management` ve `ads_read` eklenir; bağlantı bitince sayfa Reklamlar'a döner. Ardından reklam hesabı ve piksel seçilir, "Bağla"ya basılır (`ad_accounts`). Facebook Sayfası, Instagram hesabı ve Meta kataloğu otomatik bulunur.
2. **Kurallar (`ad_rules`):** satıcı bunları bir kez girer. Varsayılanlar Mustafa'nın 18 Ekim kararı:

   | Kural | Varsayılan |
   |---|---|
   | Bütçe sınırı | boş (0); girilmeden reklam açılmaz |
   | Otomatik reklam açma | kapalı |
   | Otomatik bütçe artırma | kapalı |
   | Yeni reklam | onaya düşer |
   | Hedef ROAS | 3 |
   | En düşük kâr oranı | %25 |
   | Durdurma | hedefin altında 3 gün |

   - **⚡ Tam otomatik:** satıcı günlük ve aylık sınırı girer, tek tıklar. Otomatik açma ve otomatik artırma açılır, yeni reklam doğrudan yayına çıkar; hesap hazırsa ilk reklam hemen açılır.
3. **Ürün seçimi:** `_shared/ads-engine.ts` `pickProducts` fonksiyonu seçer.
   - Kâr = satış − maliyet − komisyon. Maliyet kur tablosuyla çevrilir; maliyeti 0 ya da boş olan ürüne reklam açılmaz.
   - Başabaş ROAS (satış / kâr) hedefin altında olmalı.
   - Mağazada yayında değilse, stoğu yoksa ya da görseli yoksa ürün elenir; neden yazılır.
4. **Kampanya (`_shared/meta-ads.ts`):**
   - Sıra: OUTCOME_SALES katalog kampanyası → ürün seti (`retailer_id` = `seltigo_<ürün no>`) → reklam seti → dinamik reklam metni → reklam.
   - Reklam setinde günlük bütçe en küçük para birimiyle girilir (kuruş). Ülke kuraldan gelir. Piksel varsa hedef PURCHASE dönüşümü, yoksa bağlantı tıklamasıdır.
   - Reklam metni: AI 3 farklı metin yazar; başlık ve fiyat katalogdan (`{{product.name}}`) gelir.
   - Kampanyanın tamamı DURAKLATILMIŞ açılır. Onay modunda satıcı Reklamlar sayfasından ya da asistandan [Onayla] der; doğrudan modda hemen yayına alınır.
5. **Saatlik iş (`ads-hourly` → `ads` `run`):**
   - Meta Insights'tan günlük, reklam seti ve ürün kırılımıyla ölçüm alınır (`ad_metrics_daily`) ve harcama defteri tutulur (`ad_spend_ledger`).
   - Aylık sınır dolarsa tüm reklamlar durdurulur.
   - Günde bir optimizasyon:
     - Reklam başabaşın altında kalırsa (zarar) hemen durdurulur. Bu kontrol kapatılamaz.
     - Hedefin altında N gün kalan reklam durdurulur.
     - Hedefin %20 üstündeki reklamın bütçesi, artırma açıksa sınır içinde artırılır.
   - Otomatik açma açık olan satıcılara kendiliğinden reklam açılır.
6. **Ölçüm:**
   - Vitrinde Meta Pikseli çalışır (PageView, InitiateCheckout, Purchase; `eventID` = sipariş no).
   - Sipariş, reklam kaynağıyla birlikte kaydedilir (`store_orders.ad_source`: UTM, fbclid / fbc, fbp).
   - `create-store-order` aynı satın almayı sunucudan da Dönüşüm API'ye gönderir. Telefon ve şehir SHA-256 ile şifrelenir.
7. **Asistan:**
   - Bildirimler [Onayla] ve [Durdur] düğmeleriyle gelir.
   - Komutlar: "reklamlar nasıl", "reklamı durdur", "reklamı başlat", "reklam bütçesini 500 yap". Bütçe değişikliği de sınıra tabidir.
   - Sabah raporunda reklam özeti yer alır.

## Güvenlik
- **Canlı anahtar:** `ADS_LIVE` secret yoksa yalnız Meta sandbox (test) reklam hesabı kullanılır. Sandbox'ta reklam yayınlanmaz, para harcanmaz. Canlıya geçiş: `ADS_LIVE=true` (şirket + Meta uygulama incelemesi sonrası).
- **Sınırlar:** günlük ve aylık sınır onaylama, yeniden başlatma, bütçe değişikliği ve optimizasyon dahil her adımda kontrol edilir; Meta'ya gitmeden önce bakılır.
- **Paket anahtarı:** `ads_auto`.

## Bekleyen (Mustafa'nın Meta hesabı)
- developers.facebook.com/apps → Seltigo → Add product: **Marketing API** → Tools: **Sandbox Ad Account** oluştur → Reklamlar sayfasında "Facebook'u reklam izniyle bağla".
- Bundan sonra sandbox'ta uçtan uca test yapılacak: kampanya aç, onayla, durdur, bütçe değiştir, ölçüm.
- Not: Meta, geliştirme modundaki uygulamada reklam metni oluşturmaya izin vermeyebilir (hata 1885183). O durumda uygulamanın Live moda alınması gerekir.

## Testler
- `tests/ads/ads_test.ts`: kural motoru ve Meta istekleri (taklit) 14/14
- `tests/e2e/reklam_akisi.py`: canlı arka uç 16/16
- `tests/e2e/reklam_arayuz.py`: Reklamlar sayfası 15/15
