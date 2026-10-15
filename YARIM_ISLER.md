# Yarım işler ve sabah soruları (etsy-printify dalı, 15-16 Ekim 2026 gece)

## Güncel durum (16 Ekim, Mustafa'nın kararlarından sonra)
- Canlıda: migration 20261016_pod_seasons.sql; etsy-listings, marketplace-orders (Etsy anahtar düzeltmesi), season-calendar, pod-personalize, assistant, telegram-bot, whatsapp-webhook, meta-dm-webhook; secret PRINTIFY_TOKEN_11444569; cron season-calendar-daily (03:00 UTC), pod-personalize-5m.
- Etsy bağlantısı geri açıldı; 25 kapak uygulandı, 6 bölüm kuruldu, 5 set öne çıkan (1-5).
- Fiyat A (Offsite Ads açık, %35): S-XL 68,99 $ / 2XL 75,99 $ / 3XL 79,99 $; üretici SwiftPOD. 14 sweatshirt Etsy'de yayında (ilan numaraları %LOCALAPPDATA%\seltigo-pod\durum.json).
- BEKLEYEN: Mama (Printify sipariş onayı "elle" yapılınca `printify_yukle.py yayinla --only mama-patchwork`); numune (Türkiye adresi gelince `numune.py olustur` + `uretime`); Printify ödeme yöntemi.
- Aşağıdaki eski notların çoğu tamamlandı.

Önizleme sayfası: https://claude.ai/artifact/7iqNtbTPi4NwkBt7LqZsVx

## Takılan yerler

1. **Etsy bağlantısı "süresi doldu" durumunda (bahsistore).** Sebep bulundu: `marketplace-orders` (15 dk'da bir sipariş çeker) Etsy erişim anahtarını yenilemeden kullanıyor; anahtarın 1 saatlik süresi dolunca 401 alıyor ve bağlantıyı "expired" yapıyor. Yenileme anahtarı (90 gün) büyük ihtimalle hâlâ geçerli.
   - Düzeltme bu dalda hazır: `supabase/functions/marketplace-orders/index.ts` Etsy için önce `etsyToken` ile yeniler. Denetimden geçti, **yayınlanmadı** (canlıya onay gerekiyor).
   - Bağlantıyı veritabanında geri açma denemesi otomatik izin denetiminde reddedildi. İki yol: (a) onay verirsen düzeltme yayınlanır + bağlantı `connected` yapılıp anahtar yenilenir; (b) Mustafa Hesaplarım > Etsy > yeniden bağla.
   - Bu yüzden Etsy'ye giden işler (25 kapak, bölümler, öne çıkanlar) **hazır ama uygulanmadı**. Bağlantı açılınca tek komut:
     `%LOCALAPPDATA%\seltigo-mockup\Scripts\python.exe tools\etsy-mockup\kapak_uygula.py`
     (kapakları değiştirir: yeni görsel önce yüklenir, eskisi sonra silinir; ardından `organize.py` bölümleri kurar ve 5 seti öne çıkarır).
   - Not (diğer oturum için): `shipping-hub` 322. satırda da Etsy anahtarı yenilenmeden okunuyor; aynı düzeltme orada da gerekebilir (iade oturumunun dosyası, dokunulmadı).
2. **Printify token'ı geldi (16 Ekim)** — adı "Bahsistore"; yalnız depo kökündeki `.env` dosyasında (`PRINTIFY_TOKEN_BAHSISTORE`, .gitignore'da). Veritabanına yazılmaz; Seltigo'nun `printify_connections` kaydındaki "HizliSatici" token'ına dokunulmaz.
   - Printify mağazaları: "My new store" (11436720) hiçbir kanala bağlı değil, boş. "My Etsy Store" (11444569) Etsy'ye bağlı ve bahsistore'un mağazası (ürünlerinin Etsy ilan numaraları bahsistore'da). Koleksiyon bu mağazaya gidiyor.
   - Eski 3 ürün (21 Eylül): yaz tişörtleri. İkisi Etsy'de pasif; Printify fiyatı 2999 (29,99) Etsy'ye **29,99 TL** olarak gitmiş (Printify para birimi çevirmiyor). Üçüncüsü Etsy'ye hiç gönderilmemiş.
   - Kişiselleştirme işçisi (`pod-personalize`) sunucuda bu token'a ihtiyaç duyar: canlıya alırken Supabase secret olarak (`PRINTIFY_TOKEN_BAHSISTORE`) eklenmeli; HizliSatici kaydı ayrı kalır.
   - Noel son sipariş tarihi: Printify 2026 tarihlerini henüz açıklamadı. `season-calendar` her gün Printify sayfalarını okur; açıklanınca tüm sweatshirt ilanlarının açıklamasına ve mağaza duyurusuna "🎄 Order by … for Christmas delivery in the US." ekler, tarih geçince "⚠️ Orders placed now may arrive after Christmas." yapar, 26 Aralık'ta kaldırır. 1 Aralık'a kadar açıklanmazsa tahmin: 10 Aralık (USPS 17 Aralık − 5 iş günü üretim).
   - Numune: `tools/pod-noel/numune.py` (fiyat → olustur (taslak) → uretime). Adres `%LOCALAPPDATA%\seltigo-pod\numune.json`'da durur, depoya girmez.
3. **Canlıya alınmayı bekleyenler (onay):** migration `supabase/migrations/20261016_pod_seasons.sql`; yeni fonksiyonlar `season-calendar`, `pod-personalize`; `etsy-listings` (listing_personalization işlemi), `marketplace-orders` (Etsy anahtar düzeltmesi), `_shared/assistant-core.ts` ("notice" bildirimi → `assistant` ve `telegram-bot` yeniden yayın); zamanlanmış işler: `season-calendar` günde 1 (06:00 TR), `pod-personalize` 5 dakikada 1.
   - Bu gece yayınlanan tek şey: `etsy-listings` içine `organize` ve `listing_state` işlemleri (yalnız ekleme; açılış denendi, çalışıyor).

## Sabah Mustafa'ya sorulacaklar

1. **Fiyat.** Kesintiler + %15 Offsite Ads + %35 net kâr ile Gildan 18000: S–XL 58,99 $, 2XL 64,99 $, 3XL 69,99 $ (TL mağazada ≈ 2.419 TL). Piyasa 35–45 $.
   - A) Böyle kalsın (her satışta en az %35).
   - B) Offsite Ads'i kapat (yıllık ciro 10.000 $ altındayken Etsy kapatmaya izin veriyor) → %35 için 42,99 $ yeter.
   - C) Printify Premium (aylık ücret) → maliyet ~4 $ düşer, fiyat ~49 $ (A ile) / ~35 $ (B ile).
2. **"Most Likely To":** 8 ayrı ilan mı (şu anki hazırlık), yoksa tek ilan + alıcı ifadeyi seçsin mi (kişiselleştirme akışı bunu da otomatik basabilir)?
3. **Printify'da iki ayar (Mustafa'nın hesabı):** Printify > My stores > Etsy bağlı mı; mağaza ayarında siparişler **elle onay** olsun (yoksa Printify isimli Mama siparişini isimsiz basar; elle onaylı siparişleri sistem kendisi üretime gönderir, Mustafa hiçbir şey yapmaz).
4. **Noel'de son sipariş günü:** baskılı giysi ABD'de 2–5 gün üretim + kargo. İlan 26 Aralık'a kadar açık kalsın mı (açıklamada "Noel teslimi için Aralık başına kadar sipariş") yoksa 15 Aralık'ta pasife mi alınsın?
5. **Panelde sezon takvimi için menü / bölüm adı** (seçenekler): "Sezon Takvimi" · "Sezonlar" · "Satış Takvimi". Not: panelde zaten "Trend takvimi" (trend-calendar.html) var; birleştirilsin mi ayrı mı dursun?
6. **Etsy kapak, bölüm ve öne çıkanlar** bağlantı açılınca hemen uygulansın mı (istek zaten bu yönde; teyit).

## Bilinen sınırlar
- Etsy API "yükselen arama hacmi" vermez; sezon kontrolü resmi aramada sonuç sayısını geçen yılla karşılaştırır ve en yeni ilanlarda en sık geçen etiketleri temalara ekler.
- Printify API üretici puanı vermez; seçim bilinen yüksek puanlı ABD üreticileri listesiyle (Monster Digital, SwiftPOD, …) ve 5 renk × S–3XL şartıyla yapılır.
- Etsy'nin öne çıkan ürün sayısı sınırı (4 olabilir) belgelerde net değil; 5. set reddedilirse `organize` raporunda görünür.
- Marka kontrolü: "Just one more" ifadesi için giyimde bekleyen bir ABD başvurusu var → kitapsever tasarımında "Bookish Soul" kullanıldı. Yayından önce USPTO'da ifadeler son bir kez aranmalı.
