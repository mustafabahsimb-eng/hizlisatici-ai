# Mustafa'nın yapacakları
Yalnız senin site şifreni / girişini, hesap iznini, kart / ödemeni ya da kimlik doğrulamanı gerektiren işler burada toplanır (kalıcı kural, CLAUDE.md); Claude'un kendi yapabileceği hiçbir iş bu listeye girmez. Claude bunlar için beklemez, başka işlere devam eder. İstediğin zaman tek seferde yaparsın; bitirince "yaptım" demen yeter, gerisini Claude tamamlar.

## Meta (Facebook / Instagram / WhatsApp / reklam) — 19 Ekim 2026
1. **Bağlantıları onar (önemli; şu an bozuk):** https://mustafabahsimb-eng.github.io/hizlisatici-ai/ads.html → "Facebook'u reklam izniyle bağla" → Facebook penceresinde **tüm izinlere** izin ver.
   - Neden: Marketing API Tools'ta 6 izinle anahtar alınınca Meta, uygulamanın izinlerini 6'ya indirdi. Instagram (@mfkoleksiyon) ve WhatsApp okunamıyor; Facebook sayfasında paylaşım izni yok.
   - Bu düğme Instagram, WhatsApp, sayfa paylaşımı ve reklam izinlerinin hepsini birlikte ister.
2. **Uygulamayı Live moda al (reklam testinin son adımı):** https://developers.facebook.com/apps/1650835089949068/settings/basic → App Mode: **Live**. Gizlilik adresi istenirse: https://mustafabahsimb-eng.github.io/hizlisatici-ai/gizlilik.html
   - Neden: Meta, geliştirme modundaki uygulamanın reklam metni oluşturmasına izin vermiyor (hata 1885183).
   - Sonra Claude reklam zincirini para harcamadan (duraklatılmış aç → doğrula → sil) uçtan uca tamamlar.
3. ~~*(İsteğe bağlı)* Sandbox reklam hesabı "Seltigo Test" (act_1138060605425004) uygulamaya erişim vermiyor ("Ad account owner has NOT grant"). Gerekmiyor: test, kişisel hesapta duraklatılmış denemeyle yapılıyor. Secret `ADS_SANDBOX_TOKEN` kayıtlı.~~ — listeden çıkarıldı: gerekmiyor.

## Asistan kanalları
4. ~~**Telegram bot anahtarı**~~ — ✅ TAMAMLANDI (18 Ekim 2026): bot @SeltigoAsistanBot; `TELEGRAM_BOT_TOKEN` secret'ı, Vault'ta `seltigo_bot_token` + `seltigo_admin_chat_id`; webhook telegram-bot'a bağlı; profil fotoğrafı yüklendi; bekleme listesi bildirimi Mustafa'ya ulaştı. Bot açıklamaları (TR + EN) uygulandı (19 Ekim). Kalan (senin Telegram hesabın gerekiyor): https://mustafabahsimb-eng.github.io/hizlisatici-ai/asistan.html → "Telegram'a bağla" → açılan Telegram'da Başlat. Canlı uçtan uca testi sonra Claude yapar.
5. **Meta WhatsApp test numarası (asistan için):** https://developers.facebook.com/apps/1650835089949068/ → WhatsApp → API Setup → numara kimliği, WABA kimliği ve kalıcı anahtar → aynı secrets sayfasına `ASSISTANT_WA_PHONE_ID`, `ASSISTANT_WA_WABA_ID`, `ASSISTANT_WA_TOKEN`, `ASSISTANT_WA_DISPLAY_NUMBER`.

## Kargo / tedarik / pazaryeri
6. **Geliver hesabı:** https://app.geliver.io → Ayarlar > API Anahtarları → anahtarı Seltigo Ayarlar > 🚚 Kargo'dan bağla (test modu).
7. ~~**Printify:** ödeme yöntemi + siparişler elle onay~~ — ✅ TAMAMLANDI (16 Ekim 2026, Mustafa).
8. **Hepsiburada / Çiçeksepeti / Pazarama / PTT AVM satıcı hesapları:** sipariş alanlarının doğrulanması için (hesap açılınca).

## Para / şirket gerektirenler (karar: şirket kurulunca)
9. Chrome Web Mağazası geliştirici hesabı (tek seferlik 5 $).
10. Sabit IP sunucusu (docs/sabit-ip-kurulumu.md "Sunucuyu alacağın gün").
11. Amazon:
   - ✅ Sandbox anahtarları + uygulama numarası (App ID) kaydedildi (19 Ekim). Gerçek sandbox 7/7 (Amazon kesintisi dahil), "Amazon mağazanı bağla" akışı 16/16 (Amazon'un onay sayfası hariç).
   - **Canlıya geçmeden ÖNCE (zorunlu, güvenlik):** Client Secret ve yenileme anahtarı 19 Ekim'de sohbette paylaşıldı.
     - Amazon uygulama sayfasında **"Rotate secret"** ile Client Secret'ı yenile.
     - Uygulamayı kendi hesabına yeniden yetkilendir ("Authorize app"), yeni yenileme anahtarını al.
     - İkisini Claude'a ver; Claude secrets'a yazar. `amazon_ac.py canli`, `--secret-yenilendi` olmadan çalışmaz.
     - Sandbox için gerekmez.
   - **Şirket kurulunca / canlıya geçerken** (şimdi istenmez):
     1. Amazon satıcı hesabı (Profesyonel) aç.
     2. Solution Provider Portal "public developer" kaydı, Appstore onayı ve alıcı adresi için PII rolü (adımlar YOL-HARITASI.md "Amazon").
     3. Canlı uygulamanın "Edit App" ekranında OAuth Login URI ve OAuth Redirect URI alanlarına `https://mustafabahsimb-eng.github.io/hizlisatici-ai/amazon-callback.html` yaz. Sandbox uygulamasında bu kutular yok.
     4. https://mustafabahsimb-eng.github.io/hizlisatici-ai/accounts.html → Amazon TR → [Mağazanı Bağla] → Amazon'da onayla. Bu, zincirin denenemeyen tek adımı: Amazon'un kendi onay sayfası.
     5. Claude yukarıdaki "Rotate secret" adımından sonra `amazon_ac.py canli --secret-yenilendi --yayinda` çalıştırır.
12. AliExpress yayın başvurusu (Corporation) — docs/aliexpress-yayin-basvurusu.md.
13. Meta işletme doğrulaması + uygulama incelemesi (WhatsApp / reklam canlı; `ADS_LIVE=true`).
14. **Trendruum satıcı hesabı** (şirket kurulunca; şahıs / limited / anonim şirket ister): https://seller.trendruum.com/onboarding/satici-formu/pazaryeri → hesap açılınca "yaptım" de.
   - Neden: Trendruum'un API belgesi yalnız satıcı panelinde; kod hazır ve kapalı bekliyor (docs/trendruum.md "Açılış günü"). Claude belgeyle adresleri doğrulayıp `TRENDRUUM_ENABLED=true` ile açar.

## Son durum (16 Ekim 2026 akşam)
**Bitti ve canlıda:**
- **Etsy senkronu** (`etsy-sync`, saatlik cron `etsy-sync-1h` + Printify webhook + Etsy / Printify bağlanınca hemen): Etsy mağazasındaki tüm aktif ilanlar (Printify'dan ya da Etsy panelinden eklenenler dahil) Seltigo ürün listesine gelir; `etsy_listing_id` ile eşleşir, iki kez eklenmez. Etsy'de silinen ilan "Etsy'de yok" etiketi alır. Printify ürünlerinde maliyet Printify API'den (ürün + ABD kargo), Etsy kesintileri (%9,5 + 0,45 $) düşülür; gerçek net kâr, marj ve "Printify" etiketi gösterilir. Panel toplamları 1000 satır sınırına takılmadan hesaplanır. Tüm satıcılarda çalışır (paket anahtarı `etsy_sync`). Test `tests/e2e/etsy_senkron.py` 7/7.
  - Mustafa'nın hesabı: Etsy'de 42 ilan, 40'ı eşleşti (15 sweatshirt Printify'lı, maliyetli), panelde toplam 52 ürün. Eşleşmeyen 2 ilan aktif değil (eski pasif yaz tişörtleri); kural gereği yalnız aktif ilanlar içe aktarılır.
- **İçerik otomasyonu** son iki adım ("paylaşıldı" durumu, onaysız içeriğin atlanması) test edildi: `tests/e2e/icerik_akisi.py` 18/18. Testte bulunan hata düzeltildi: haftalık plan görselleri tek istekte çizilince fonksiyon işlem sınırına takılıp son günleri oluşturmuyordu; artık parça parça çiziliyor (docs/icerik-otomasyonu.md).

**Yarım / sıradaki:**
- Facebook / Instagram / WhatsApp bağlantısı bozuk (Meta izinleri 6'ya indi) → aşağıda Mustafa'nın yapacakları 1. Bu düzelmeden içerik otomasyonu ve reklamlar gerçek hesapta paylaşım yapamaz (testler sahte bağlantıyla geçiyor).
- Meta uygulaması Live moda alınınca reklam zincirinin son adımı (duraklatılmış aç → doğrula → sil) Claude tarafından tamamlanacak.
- Eski notlardaki "Etsy bağlantısı süresi doldu" çözüldü (bağlantı açık, senkron saatlik başarılı).

## Claude'un verdiği kararlar (isteğe bağlı gözden geçirme; değiştirmek istersen söyle)
- İçerik otomasyonu adları: menü "🗓️ İçerik Takvimi"; "Otomatik içerik", "Günde gönderi", "Haftada hikâye", "Paylaşım saati", "Kanallar", "Yayından önce onayıma sun", "Planı şimdi oluştur", "Hepsini onayla", "Onayla", "Atla", "Metni düzenle", "Şimdi paylaş", "Gönderiyi aç"; şablonlar Ürün fotoğrafı / Fiyat etiketi / Kolaj / Özel gün / Hikâye; durumlar Onay bekliyor / Zamanlandı / Paylaşılıyor / Paylaşıldı / Hata / Atlandı. Varsayılan: kapalı, günde 1, haftada 3 hikâye, 19:30, onay açık.
- Etsy senkronu: Etsy'de silinen ilan panelden silinmez, "Etsy'de yok" etiketiyle kalır (satış / kâr geçmişi kaybolmasın). Dışarıda (Printify / Etsy) yönetilen ilanlar Seltigo'dan Etsy'ye geri yazılmaz.
- İçerik planı: bir istekte en fazla 3 görsel, kalan için kendini yeniden çağırma; panel bitene kadar "Hazırlanıyor…" gösterir.
- Seltigo Ads: sandbox hesabı yerine kişisel reklam hesabında para harcamayan "duraklatılmış aç → doğrula → sil" denemesi; kampanyada setler arası bütçe paylaşımı kapalı.
- Amazon (19 Ekim):
  - Fiyat pazarın x,99 kuralına yukarı yuvarlanır (asla düşmez; JPY / INR kuruşsuz).
  - Komisyon varsayılanı %15 (zarar kontrolü bununla).
  - Ana görsel otomatik düzeltilir; ücretli zemin silme varsayılan kapalı (`AMAZON_AUTO_BG_REMOVE`).
  - Kategori onayı gereken ASIN'e teklif açılmaz, onay bağlantısı ilana yazılır.
  - Reddedilen ilan en fazla 2 kez AI ile düzeltilip yeniden gönderilir.
  - Siparişler Orders API v2026-01-01'e geçti.
- Kargo (19 Ekim): 3 günden eski test gönderileri izlenmez; siparişi silinmiş gönderi "iptal" olur. Test kullanıcısının 42 yetim test gönderisi iptal edildi (silinmedi).
- Telegram bot açıklamaları (19 Ekim): 18 Ekim'de gösterilen TR / EN metinler aynen uygulandı.
- Trendruum (19 Ekim): Hesaplarım kartı alt yazısı "Yeni yerli pazaryeri, 14 günde ödeme"; alanlar Trendruum'un kendi adlarıyla "Client ID" / "Client Secret". Entegrasyon kapalıyken bağlantı "onay bekliyor" kaydedilir, açılınca kendiliğinden doğrulanır. Canlı açıldığında ilanlar prova beklemeden gönderilir (tek anahtar `TRENDRUUM_ENABLED`). Komisyon oranı uydurulmadı (dışarıda yayınlanmıyor); satıcı girer, sonra API'den okunacak.

---

# Yarım işler ve sabah soruları (etsy-printify dalı, 15-16 Ekim 2026 gece)

## Güncel durum (16 Ekim, Mustafa'nın kararlarından sonra)
- Canlıda: migration 20261016_pod_seasons.sql; etsy-listings, marketplace-orders (Etsy anahtar düzeltmesi), season-calendar, pod-personalize, assistant, telegram-bot, whatsapp-webhook, meta-dm-webhook; secret PRINTIFY_TOKEN_11444569; cron season-calendar-daily (03:00 UTC), pod-personalize-5m.
- Etsy bağlantısı geri açıldı; 25 kapak uygulandı, 6 bölüm kuruldu, 5 set öne çıkan (1-5).
- Fiyat A (Offsite Ads açık, %35): S-XL 68,99 $ / 2XL 75,99 $ / 3XL 79,99 $; üretici SwiftPOD. 14 sweatshirt Etsy'de yayında (ilan numaraları %LOCALAPPDATA%\seltigo-pod\durum.json).
- Mama yayında (16 Ekim). Printify kartı, sipariş onayı Manual ve Etsy Offsite Ads kapalı (Mustafa, 16 Ekim; API bu ayarları göstermiyor, doğrulanamadı). Numune YOK: alınmayacak, bir daha sorulmayacak; numune.py kaldırıldı. Telegram botu: ✅ bağlandı (18 Ekim).
- Aşağıdaki eski notların çoğu tamamlandı.

Önizleme sayfası: https://claude.ai/artifact/7iqNtbTPi4NwkBt7LqZsVx

## Takılan yerler — ✅ hepsi çözüldü (19 Ekim kontrolü)
- 1 (Etsy "süresi doldu"): düzeltme yayında, bağlantı açık, kapak / bölüm / öne çıkanlar uygulandı. `shipping-hub` artık Etsy anahtarı okumuyor (not geçersiz).
- 2 (Printify token'ı): secret `PRINTIFY_TOKEN_11444569` kayıtlı, `pod-personalize` çalışıyor.
- 3 (canlıya alınacaklar): hepsi canlıda (bkz. "Güncel durum").

Eski notlar (arşiv):


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
3. **Canlıya alınmayı bekleyenler (onay):** migration `supabase/migrations/20261016_pod_seasons.sql`; yeni fonksiyonlar `season-calendar`, `pod-personalize`; `etsy-listings` (listing_personalization işlemi), `marketplace-orders` (Etsy anahtar düzeltmesi), `_shared/assistant-core.ts` ("notice" bildirimi → `assistant` ve `telegram-bot` yeniden yayın); zamanlanmış işler: `season-calendar` günde 1 (06:00 TR), `pod-personalize` 5 dakikada 1.
   - Bu gece yayınlanan tek şey: `etsy-listings` içine `organize` ve `listing_state` işlemleri (yalnız ekleme; açılış denendi, çalışıyor).

## Sabah Mustafa'ya sorulacaklar — ✅ tamamlandı (19 Ekim; açık kalanlar Claude'un kararıyla kapatıldı)
- 1 Fiyat: kalıcı kural CLAUDE.md'de (her sweatshirt satışından net en az 10 $).
- 2 "Most Likely To": 8 ayrı ilan olarak yayında; değiştirilmez (Etsy'de yeni ilan / kopya yasak, her ilan ücretli).
- 3 Printify ayarları: Mustafa yaptı (16 Ekim).
- 4 Noel: ilanlar açık kalır; `season-calendar` açıklamaya son sipariş tarihini yazar, tarih geçince uyarı, 26 Aralık'ta kaldırır.
- 5 Sezon takvimi menüsü: ayrı menü açılmadı; işler arka planda, bildirimi asistan verir ("Trend takvimi" sayfası ayrı kalır).
- 6 Etsy kapak / bölüm / öne çıkanlar: uygulandı.

Eski sorular (arşiv):


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
- Marka kontrolü: ✅ USPTO'da yapıldı (19 Ekim; tekrarlanabilir: `python tools/pod-noel/marka_kontrol.py`, yalnız resmi USPTO araması):
  - Temiz: Bookish Soul, Gingerbread Season, Nap Season, Cozy Mode, Burn / Eat The Cookies, Snowball, Carols ve diğer Most Likely To cümleleri.
  - **MOST LIKELY TO** (8 ilan): giyimde 2 başvuru; birinde "Notice of Allowance" (kayda yakın). Karar: şimdilik kalır; kayda dönerse ifade başlık ve etiketlerden kaldırılır (Printify güncelleme, aynı ilan numarası). Her POD işinde Claude kontrolü yeniden çalıştırır.
  - STAY COZY (kurbağa): askıda bir başvuru; izlenir.
  - MAMA: giyimde kayıtlı (Mothers Against Media Addiction). Bizde genel kelime olarak, çocuk isimleriyle açıklayıcı kullanım: kalır.
  - THE NAUGHTY LIST kayıtlı; bizdeki "Be On The Naughty List" cümlesi: düşük risk, kalır.
