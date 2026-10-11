# Mimari plan: Seltigo Ads, İçerik otomasyonu, İade otomasyonu

Durum: TASLAK, onay bekliyor (13 Ekim 2026). Kodlamaya Mustafa onayından sonra başlanır.
Arayüz adları bu belgede yalnız çalışma adıdır; gerçek adlar ayrıca onaya sunulur.

## Ortak ilkeler (üçü için)
- **Aynı altyapı:** Supabase (Postgres + Edge Functions + Vault + zamanlanmış görevler), aynı ürün / ilan / sipariş tabloları. Ayrı ürün = ayrı paket, ayrı kod değil.
- **Paket kontrolü:** `user_memberships` tablosu zaten var (admin hediye üyelik veriyor) ama hiçbir özellik ona bakmıyor. Önce tek bir `feature_enabled(user, özellik)` fonksiyonu yazılır; üç ürün de buna bağlanır. Fiyatlar ve paket içerikleri Mustafa'nın kararı.
- **Otomasyon + güvenlik:** Her iş kuyrukta çalışır ve tekrar dener. Para harcayan ya da müşteriye giden her işte varsayılan kural ve üst sınır vardır. Satıcı ilk seferde onaylar, sonrası otomatik yürür. Kararlar asistandan da yönetilir: bildirim, [Onayla] [Durdur] düğmeleri.
- **Varsayılan KAPALI anahtar:** Ücretli servisler ve şirket isteyen hesaplar için kod şimdi hazırlanır, anahtar girilince açılır.
- **Ölçüm:** Her ürünün kârı `marketplace_orders.net_profit_home` üzerinden. Reklam ve iade maliyeti de bu kâra işlenir (Kâr-Zarar raporu ve ertelenen "Kâr kaçağı dedektörü" aynı veriyi kullanır).

---

## 1. Seltigo Ads (reklam otomasyonu)
**Amaç:** Satıcı bütçe ve hedef kâr oranını bir kez girer. Sistem en çok kâr getiren ürünlere reklamı kendisi açar, izler, büyütür ya da durdurur.

**Var olan temel:** Meta kataloğu (social-catalog, catalog-feed), reklam görseli (reklam-gorseli.html, Görsel Stüdyosu), rakip reklam kancaları (ads-spy), trend takvimi, mağazadan dışarı tıklama kaydı (store_outbound_clicks).

**Kanallar (öncelik sırası):**
1. **Meta (Facebook + Instagram):** Marketing API, Advantage+ katalog reklamları. Mevcut Meta kataloğu doğrudan kullanılır.
   - Gerekenler: `ads_management` izni için Meta uygulama incelemesi ve işletme doğrulaması (şirket sonrası). Test için Meta'nın sandbox reklam hesabı kullanılabilir.
2. **Google Alışveriş / Performance Max:** Merchant Center beslemesi (catalog-feed zaten Google biçimini veriyor) + Google Ads API.
   - Gerekenler: geliştirici anahtarı başvurusu (şirket web sitesi istenir). Test hesabı hemen açılabilir.
3. **TikTok:** Marketing API + katalog.
   - Gerekenler: TikTok For Business hesabı ve uygulama onayı.
4. **Pazaryeri reklamları** (Trendyol, Amazon Sponsored Products): Amazon Ads API ayrı onay ister, Trendyol'un açık reklam API'si yok. Bunlar sona kalır.

**Bileşenler:**
- **Tablolar:** `ad_accounts` (anahtarlar Vault'ta), `ad_campaigns`, `ad_creatives`, `ad_metrics_daily` (ürün × kanal × gün: harcama, tıklama, satış, ROAS), `ad_rules` (satıcı kuralları), `ad_spend_ledger` (harcama defteri, üst sınır kontrolü).
- **Fonksiyonlar:**
  - `ads-connect`: OAuth bağlantısı.
  - `ads-creative`: AI metin + mevcut görsel stüdyosu + ads-spy kancaları; her üründen 3 farklı reklam.
  - `ads-launch`: kampanya ve reklam setlerini açar.
  - `ads-metrics-sync`: saatlik/günlük metrik çekme.
  - `ads-optimizer`: kural motoru. Örnek: ROAS hedefin altındaysa 3 gün sonra durdur, üstündeyse bütçeyi %20 artır. Asla günlük/aylık üst sınırı aşmaz.
- **İzleme:** mağaza sayfasına Meta Pixel + Conversions API (sunucudan), Google etiketi, UTM. Sipariş hangi reklamdan geldi bilgisi `store_orders` ve `marketplace_orders` kayıtlarına yazılır.
- **Kâr odaklı seçim:** reklam yalnız kârı (ürün + kargo + komisyon + reklam) hedefin üstünde kalan ürünlere açılır. Zarar kontrolü kapatılamaz (CJ kararındaki gibi).
- **Asistan:** sabah raporuna reklam özeti, "reklamı durdur", "bütçeyi 500 yap" komutları.

**Aşamalar:** A1 Meta katalog reklamı (sandbox) → A2 optimizasyon kuralları + asistan → A3 Google → A4 TikTok → A5 pazaryeri reklamları.
**Mustafa'nın kararları:** paket fiyatı, varsayılan bütçe sınırı, otomatik bütçe artırma açık mı.

---

## 2. İçerik otomasyonu
**Amaç:** Her ürün ve kampanya için sosyal medya içeriği (gönderi, hikâye, kısa video, atlıkarınca) kendiliğinden üretilir, takvime konur, yayınlanır. Sonuçlar izlenir ve iyi giden içerik türü daha sık üretilir.

**Var olan temel:** channel-copy (kanala göre metin), instagram-worker (paylaşım kuyruğu), social-publish, Görsel Stüdyosu, remove-background, trend-calendar, bundle-suggest.
- **ÖNCE DÜZELTİLMELİ (kritik):** instagram-worker durumu "processing / published / canceled" yazıyor, `social_posts` tablosu ise yalnız "pending / posting / posted / error" kabul ediyor. Bu yüzden kuyruktaki otomatik paylaşımlar şu an hiç işlenemiyor (eksik taramasında 1. madde).

**Bileşenler:**
- **Tablolar:** `content_calendar` (gün, kanal, tür, ürün/kampanya), `content_items` (metin, medya, durum, onay), `content_metrics` (erişim, etkileşim, tıklama, satış).
- **Üretici:** `content-generate`.
  - Metin: channel-copy + trend takvimi.
  - Görsel şablonlar: kolaj, fiyat etiketi, öncesi/sonrası.
  - Kısa video: ürün görsellerinden 10-15 sn'lik video. Edge Function video işleyemez; dış video servisi kullanılır (Shotstack / Creatomate gibi, ücretli, varsayılan KAPALI).
- **Planlayıcı:** haftalık takvimi doldurur. Satıcının seçtiği sıklıkla çalışır (ör. günde 1 gönderi, haftada 3 hikâye); bayram ve indirim günleri trend takviminden gelir.
- **Yayıncılar:**
  - Instagram (var, düzeltilecek), Facebook Sayfası.
  - TikTok Content Posting API (uygulama denetimi gerekir), Pinterest, YouTube Shorts.
  - WhatsApp kanalı/durum: API'si yok, yapılamaz.
- **Öğrenme:** içerik türü × saat × ürün türü başına performans tutulur; planlayıcı iyi gideni öne alır.
- **Onay modu:** asistandaki gibi "yayından önce onay iste / direkt yayınla".

**Aşamalar:** İ1 instagram-worker düzeltmesi + takvim + görsel şablonlar → İ2 Facebook + ölçüm → İ3 kısa video (ücretli servis) → İ4 TikTok / Pinterest / YouTube.
**Mustafa'nın kararları:** video servisi ödemesi, varsayılan paylaşım sıklığı, paket.

---

## 3. İade otomasyonu
**Amaç:** İade talebinden paranın iadesine ve stoğa geri dönüşe kadar her adım otomatik ilerler. Satıcı yalnız kuralın dışındaki talepleri onaylar.

**Var olan temel:**
- Müşteri takip sayfası (takip.html).
- Kargo merkezi (shipping-hub: gönderi + etiket).
- Asistanda "↩️ İade talebi" uyarı biçimi (renderAlert "return") hazır, ama bu uyarıyı tetikleyen bir kayıt henüz yok.
- Ayarlar'da iade adresi alanı.

**Bileşenler:**
- **Tablolar:**
  - `returns`: sipariş bağlantısı, kanal, neden, fotoğraflar, tutar.
  - Durum akışı: talep → onaylandı → iade kodu/etiket → yolda → teslim alındı → para iadesi / red.
  - `return_rules`: örnek kurallar "X TL altı otomatik onay", "14 gün içinde", "neden = beden uymadı → otomatik onay", "kusurlu → fotoğraf iste".
  - `refund_ledger`: para iadesi defteri.
- **Talep kaynakları:**
  - Kendi Mağazam: takip sayfasında "İade talebi" formu (neden + fotoğraf). Ad onaya sunulacak.
  - Pazaryerleri: Trendyol claims, Hepsiburada iade servisi, Amazon iade raporu (Reports API) → canlı bağlantılar gelince.
  - Tedarikçi: AliExpress/CJ ürünü kusurluysa CJ dispute (anlaşmazlık) API'si ile tedarikçiden iade/kredi talebi.
- **Otomasyon:**
  - AI neden sınıflandırma ve fotoğraf kontrolü.
  - Kurala göre otomatik onay.
  - shipping-hub ile iade kodu/etiket (Yurtiçi/Geliver iade gönderisi).
  - Müşteriye WhatsApp/e-posta bildirimi (şablon onaylı).
  - Teslim alınınca stok +1 ve ürün yeniden satışa.
  - Para iadesi: ödeme altyapısına bağlı. Kendi Mağazam'da henüz ödeme yok (kapıda/havale); ödeme sağlayıcı gelince otomatik iade.
- **Kâra etkisi:** iade kargo masrafı ve komisyon farkı siparişin net kârına işlenir. Raporlar ve Kâr kaçağı dedektörü bunu görür.
- **Yasal:** Türkiye Mesafeli Sözleşmeler Yönetmeliği (14 gün cayma) ve AB 14 gün; süre ve istisnalar kurallara gömülü (kişiye özel ürün, hijyen ürünleri).

**Aşamalar:** R1 Kendi Mağazam iade akışı + kurallar + iade etiketi + stok → R2 asistan + müşteri bildirimi → R3 pazaryeri iadeleri (canlı bağlantılarla) → R4 tedarikçi anlaşmazlığı (CJ).
**Mustafa'nın kararları:** varsayılan otomatik onay sınırı, iade formunun adları, paket.

---

## Önerilen sıra ve kaba süre (kodlama, Claude ile)
1. İçerik İ1: instagram-worker düzeltmesi zaten kritik; 1-2 gün.
2. İade R1-R2: şirket gerektirmez, hemen değer verir; 3-4 gün.
3. Ads A1-A2: Meta sandbox'ta kurulur, canlıya şirket sonrası geçer; 4-5 gün.
4. Diğer aşamalar: hesap onayları geldikçe.
