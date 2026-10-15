# Yarım işler ve sabah soruları (etsy-printify dalı, 15-16 Ekim 2026 gece)

Önizleme sayfası: https://claude.ai/artifact/7iqNtbTPi4NwkBt7LqZsVx

## Takılan yerler

1. **Etsy bağlantısı "süresi doldu" durumunda (bahsistore).** Sebep bulundu: `marketplace-orders` (15 dk'da bir sipariş çeker) Etsy erişim anahtarını yenilemeden kullanıyor; anahtarın 1 saatlik süresi dolunca 401 alıyor ve bağlantıyı "expired" yapıyor. Yenileme anahtarı (90 gün) büyük ihtimalle hâlâ geçerli.
   - Düzeltme bu dalda hazır: `supabase/functions/marketplace-orders/index.ts` Etsy için önce `etsyToken` ile yeniler. Denetimden geçti, **yayınlanmadı** (canlıya onay gerekiyor).
   - Bağlantıyı veritabanında geri açma denemesi otomatik izin denetiminde reddedildi. İki yol: (a) onay verirsen düzeltme yayınlanır + bağlantı `connected` yapılıp anahtar yenilenir; (b) Mustafa Hesaplarım > Etsy > yeniden bağla.
   - Bu yüzden Etsy'ye giden işler (25 kapak, bölümler, öne çıkanlar) **hazır ama uygulanmadı**. Bağlantı açılınca tek komut:
     `%LOCALAPPDATA%\seltigo-mockup\Scripts\python.exe tools\etsy-mockup\kapak_uygula.py`
     (kapakları değiştirir: yeni görsel önce yüklenir, eskisi sonra silinir; ardından `organize.py` bölümleri kurar ve 5 seti öne çıkarır).
   - Not (diğer oturum için): `shipping-hub` 322. satırda da Etsy anahtarı yenilenmeden okunuyor; aynı düzeltme orada da gerekebilir (iade oturumunun dosyası, dokunulmadı).
2. **Printify token'ı yok.** Her şey hazır: `python tools/pod-noel/printify_yukle.py hazirla` (sahte Printify ile uçtan uca test geçti: `tests/pod/printify_yukle_test.py`).
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
