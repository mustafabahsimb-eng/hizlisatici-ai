# İçerik otomasyonu (İ1 + İ2) — 2026-10-16

## Akış
1. **Ayarlar** (`content_settings`, panel 🗓️ İçerik Takvimi) varsayılan olarak şöyle başlar:
   - Otomatik içerik kapalı.
   - Günde 1 gönderi, haftada 3 hikâye, saat 19:30.
   - Kanallar: Instagram + Facebook.
   - Yayından önce onay istenir.
2. **Plan** (`content` `plan` ya da saatlik iş, `_shared/content-engine.ts`):
   - Önümüzdeki 7 gün planlanır.
   - Ürün sırası: yeni ürün > çok satan > uzun süredir paylaşılmayan.
   - Özel güne 3 gün kala "Özel gün" şablonu kullanılır.
   - Şablon ve saat seçiminde etkileşime göre öğrenme yapılır; %20 keşif payı bırakılır.
3. **Görsel** (`_shared/content-render.ts`, imagescript + Poppins):
   - Gönderi şablonları (1080x1350): Ürün fotoğrafı, Fiyat etiketi, Kolaj (4 ürün), Özel gün.
   - Hikâye şablonu: 1080x1920.
   - Görseller `content-media` deposuna yazılır (herkese açık).
   - WebP / AVIF ürün görselleri wsrv.nl ile JPEG'e çevrilir.
4. **Metin:** AI tek çağrıda bütün gönderilerin metnini yazar (Türkçe, hashtag'li); AI yanıt vermezse hazır şablon metin kullanılır. Hikâyelerde metin yoktur.
5. **Paylaşım** (saatlik `content-hourly`):
   - Instagram'a `social_posts` kuyruğu üzerinden gider (`instagram-worker`; gönderi ve hikâye, ürünsüz görsel desteği).
   - Facebook Sayfası'na doğrudan fotoğraflı gönderi atılır.
   - Onaylanmadan zamanı geçen içerik atlanır.
6. **Ölçüm:** 12 saatte bir beğeni, yorum, erişim ve kaydetme sayıları okunur → öğrenme.
7. **Asistan:** içerik hazır bildirimi + [Hepsini onayla].

Paket anahtarı: `content_auto`.

## Testler
- `tests/content/content_engine_test.ts`: planlayıcı ve öğrenme, 8/8.
- `tests/e2e/icerik_akisi.py`:
  - Son tam koşu: 14/14 madde geçti.
  - Kalan adımlar (kuyruğun "paylaşıldı" olması, onaysız içeriğin atlanması) test bekleme hatası yüzünden koşmadı; hata düzeltildi.
  - Tekrar koşu bilgisayarda bellek azlığı nedeniyle durduruldu.

## Henüz yok (İ3 / İ4, yol haritasında)
- Kısa video: ücretli servis gerekir (Shotstack / Creatomate); varsayılan kapalı.
- TikTok, Pinterest, YouTube Shorts.
