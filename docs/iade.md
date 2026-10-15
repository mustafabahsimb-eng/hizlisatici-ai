# İade otomasyonu (15 Ekim 2026)

## Akış
1. **Talep:** müşteri takip sayfasında (`takip.html?t=`) "↩️ İade talebi" → "İade talebi oluştur". Pazaryerlerinde iade 30 dakikada bir okunur: Trendyol claims, n11 ReturnService ve Etsy (siparişteki iade / iptal).
2. **Karar:** `_shared/returns-law.ts` dosyası yasal çerçeveyi, satıcı kuralını, AI fotoğraf kontrolünü ve şüphe kontrolünü birlikte değerlendirir.
   - Talep otomatik onaylanır ya da satıcıya düşer.
   - Satıcı kararı üç yerden verilebilir: Siparişler > "↩️ İadeler", asistan düğmeleri, `returns` fonksiyonu.
3. **Onay:**
   - İade etiketi `shipping-hub` ile açılır. Kargo hesabı varsayılan hesaptır; alıcı satıcının iade adresi, gönderen müşteridir.
   - Dropshipping (CJ / AliExpress) ürünü geri istenmez. Para iadesi hemen açılır; ürün kusurluysa CJ'ye anlaşmazlık (dispute) açılır.
4. **Ürün satıcıda:** kargo takibi "teslim" olunca ya da satıcı "Teslim aldım" deyince ürün stoğa geri eklenir ve para iadesi defterine (`refund_ledger`) yazılır.
   - Kendi Mağazam'da ödeme altyapısı yok. Para iadesini satıcı yapar ve "Parayı iade ettim" der.
   - Pazaryerinde parayı pazaryeri iade eder.
5. **Para iadesi süresi:** `refund_due_at` alanında tutulur.
   - TR: ürün iade kargosuna verildikten sonra 14 gün. AB / GB: cayma bildiriminden 14 gün. ABD: onaydan sonra.
   - Son güne `refund_warn_days` (varsayılan 3) kala satıcıya asistan / panel uyarısı gider.

## Yasal çerçeve (`return_laws`; bölge `return_law_region(ülke)` ile, AB = `countries.eu_member`)
Hangi hukukun uygulanacağı alıcının ülkesine göre belirlenir; alıcının ülkesi yoksa satıcının ana ülkesi kullanılır. Satıcı yasal minimumun altına inemez, yalnızca müşteri lehine değiştirebilir.

| | TR | AB / GB | ABD / diğer |
|---|---|---|---|
| Cayma | 14 gün, gerekçesiz, **reddedilemez** | 14 gün | yasal yok; mağaza politikası (varsayılan 30 gün) |
| İade kargosu | müşteriden **alınamaz** (ayar kilitli) | müşteri ödeyebilir, ön bilgilendirmede yazılıysa | politika |
| Para iadesi | iade kargosuna verilişten 14 gün, ilk kargo ücreti dahil | bildirimden 14 gün (ürün dönene kadar bekletilebilir) | onaydan sonra |
| Fotoğraf | yalnız ayıplı malda (kusurlu / hasarlı / yanlış / açıklamayla uyuşmuyor) | aynı | aynı |
| Ayıp bildirimi | 2 yıl | 2 yıl | 1 yıl |

- **Otomatik onay sınırı:** cayma talebinin onayına ya da reddine karar vermez. Yalnız ayıp iddialarında ve şüphe kontrolünde (son 90 günde 3+ iade, yüksek tutar) kullanılır. Varsayılan 1.000 TL.
- **"Cayma hakkı yok" (`products.withdrawal_exempt`):** kişiye özel, dijital, hijyen (ambalajı açılmış), çabuk bozulan, fiyatı piyasaya bağlı, açılmış kitap / yazılım.
  - Dijital ürünler ve Printify'ın kişiselleştirilmiş ürünleri otomatik işaretlenir.
  - Telefon, bilgisayar, tablet ve akıllı saat istisna değildir.
  - İstisna üründe formda yalnız ayıplı mal nedenleri çıkar.
- **İade taşıyıcısı ve iade kodu:** her siparişe otomatik atanır (`store_orders.return_carrier / return_code`).
- **Ön bilgilendirme ve İade Politikası:** metin otomatik üretilir (`returns` → `policy`). Vitrinde sipariş öncesi onay zorunludur; metin alt bilgide ve takip sayfasında da görünür.
- **Adresten alım:** TR'de müşteri "Yakınımda kargo şubesi yok" seçeneğini işaretlerse `returns.pickup` işaretlenir; panelde ve asistanda görünür.

## Etsy
Etsy Open API v3 cayma talebini vermiyor. Webhook'lar yalnız `order.paid / canceled / shipped / delivered` olaylarını kapsıyor (developers.etsy.com, 15 Ekim 2026). Etsy'de yapılan para iadeleri ve iptaller siparişten (ShopReceipt `status`, `refunds[]`) okunur ve "pazaryeri iade etti" olarak akışa girer. Talebin kendisini otomatik yakalama yolu: YOL-HARITASI.md "İade — sıradaki".

## Testler
- `tests/returns/returns_law_test.ts` (yasal karar, Etsy adaptörü) 15/15
- `tests/returns/returns_adapters_test.ts` (Trendyol, n11) 4/4
- `tests/e2e/iade_akisi.py` (uçtan uca, Yurtiçi test ortamı) 34/34
- `tests/e2e/iade_arayuz.py` (takip sayfası, İadeler sekmesi, İade Kuralları, Cayma hakkı yok, vitrin, asistan) 28/28
