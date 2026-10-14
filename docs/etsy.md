# Etsy (doğrudan bağlantı) — dijital ürün ve klasörden toplu yükleme

## Akış
1. **Bağlantı:** Hesaplarım > Etsy > "Mağazanı Bağla" → Etsy onay sayfası (OAuth 2.0 + PKCE; izinler: listings_r/w/d, shops_r/w, transactions_r/w, email_r) → `etsy-callback.html` (state zorunlu) → `etsy-token-exchange`.
   - Kullanıcı oturum anahtarından bulunur; gövdedeki userId oturumla uyuşmazsa 403.
   - Mağaza numarası ve adı kaydedilir; anahtarlar `store_connections` + Vault'ta durur.
   - Anahtar yenileme `_shared/etsy.ts` ve `token-refresher` üzerinden yapılır.
2. **Dijital ürün:** `products.product_type = digital`. Dosyalar `product_files` tablosunda ve özel `product-files` deposunda durur; ürün başına en fazla 5, dosya başı en fazla 20 MB. Dijital üründe kargo gönderisi açılmaz. Ürün düzenleme sayfasında "Ürün tipi" ve "İndirilebilir dosyalar (en fazla 5)" bölümleri var.
3. **İlan:** Kanal `etsy` ilanı → ilan kuyruğu (sync-worker) → `etsy-listings` (ilan başına ayrı çağrı) → `_shared/etsy-listing.ts`.
   - Taslak ilan özellikleri: `type: download`, Digital Prints (kategori numarası Etsy kategori ağacından bulunup `app_cache`'e alınır), `who_made: i_did`, `when_made: 2020_2026`, `is_supply: false`.
   - Ardından görseller yüklenir (en fazla 10), sonra dosyalar (en fazla 5).
   - `listings.attributes.etsy_publish = true` ise ilan yayınlanır (`state=active`); değilse taslak kalır (varsayılan).
   - Sonraki gönderimlerde ilan güncellenir (başlık / açıklama / etiketler + fiyat / adet). Yüklenmiş görsel ve dosya tekrar yüklenmez. Seltigo'da silinen dosya Etsy'den de silinir.
   - Sonuç `listings.validation.etsy` alanına yazılır (Etsy ilan no, durum, adres).
4. **Klasörden toplu yükleme:** Toplu Yükleme > "📁 Klasörden yükle" > "Klasör seç".
   - Ön kontrol yapılır; eksik açıklama ve etiketleri AI tamamlar (`channel-copy`, kanal etsy, 13 etiket).
   - Sonra "Taslak olarak gönder" (varsayılan) ya da "Gönder ve yayınla" seçilip "Etsy'ye gönder"e basılır.
   - Her ürünün Etsy sonucu satırında görünür.

## Klasör biçimi
Klasörde görseller, indirilebilir dosyalar ve bir `.json` dosyası bulunur:
```json
{
  "products": [
    { "title": "Sun Wall Art Printable", "description": "…", "tags": ["sun print", "boho wall art"], "price": 4.99,
      "images": ["cover-sun.jpg", "mockup-2.jpg"], "files": ["sun-8x10.pdf", "sun-A4.pdf"] },
    { "title": "Fern Botanical Print", "price": 3.5, "folder": "fern" }
  ]
}
```
- Fiyat, Etsy mağazasının para biriminde yazılır.
- `folder` verilen üründe o alt klasördeki görseller ve dosyalar alınır.
- Dosyası olan ürün dijitaldir; istenirse `"type": "physical"` yazılabilir (fiziksel ürün için Etsy mağazasında kargo profili gerekir).
- Sınırlar: en fazla 10 görsel, 5 dosya, dosya başı 20 MB. Başlıkta en fazla 140 karakter; Etsy'nin kuralı gereği `%`, `:` ve `&` birer kez. En fazla 13 etiket, her biri en fazla 20 karakter; bunlara kod kendisi uyar.

## Etsy kuralları ve anahtarlar
- Etsy 9 Şubat 2026'dan beri her istekte `x-api-key: <keystring>:<shared secret>` istiyor. Gizli anahtar Supabase'de `ETSY_SHARED_SECRET` olarak duruyor. Uygulama anahtarının (keystring) TEK kaynağı Supabase secret `ETSY_KEYSTRING`; kodda sabit değer yok. Hesaplarım sayfası değeri `etsy-token-exchange` `{action:"config"}` ile alır. Onay adresinde (`oauth/connect`) ve anahtar isteklerinde `client_id` = keystring; tüm v3 isteklerinde `x-api-key` = `keystring:shared secret`.
- Teşhis: `etsy-listings` `{action:"ping"}` (sistem çağrısı) anahtarın Etsy'de kabul edilip edilmediğini durum koduyla söyler; değer göstermez.
- Ücret: Etsy yayınlanan her ilan için ilan ücreti alır. Taslak ücretsizdir.

## Testler
- `tests/etsy/etsy_listing_test.ts`: taklit Etsy ile taslak, görsel, dosya, yayınlama, güncelleme, silinen dosya, eksik kontrolleri ve kota tekrarı (9/9).
- `tests/e2e/etsy_dijital.py`: bağlantı güvenliği ve dijital ürün dosyaları.
- `tests/e2e/etsy_klasor.py`: klasörden yüklemeden Etsy'ye devire kadar uçtan uca (15/15).
